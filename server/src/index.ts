import express from 'express';
import { createServer } from 'http';
import { Server as SocketIO } from 'socket.io';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { connectDatabase } from './database/connection';
import { seedInitialPrompt, getCurrentPrompt, generateAndApplyPatch } from './services/promptEvolution/selfHealingPrompt';
import { AgentPipeline } from './services/agent/agentPipeline';
import { runCallAnalysis } from './services/analysis/callAnalysis';
import { Call } from './database/models/Call';
import { deleteRoom } from './services/livekit/roomService';
import callRoutes from './routes/calls';
import analysisRoutes from './routes/analysis';
import promptRoutes from './routes/prompts';
import healthRoutes from './routes/health';
import { logger } from './utils/logger';

// Ensure uploads directory exists
fs.mkdirSync(config.uploads.dir, { recursive: true });

const app = express();
const httpServer = createServer(app);

const io = new SocketIO(httpServer, {
  cors: {
    origin: config.clientUrl,
    methods: ['GET', 'POST'],
  },
  maxHttpBufferSize: 1e7, // 10MB for audio chunks
});

app.use(cors({ origin: config.clientUrl }));
app.use(express.json({ limit: '1mb' })); // Prevent JSON body abuse
app.use('/uploads', express.static(config.uploads.dir));

// --- Rate Limiting ---
// General API: 120 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests — slow down' },
});

// Call start: max 10 new calls per minute per IP (protects external API spend)
const callStartLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many call attempts — wait before retrying' },
});

// REST routes
app.use('/api/health', healthRoutes);
app.use('/api/calls/start', callStartLimiter);
app.use('/api/calls', apiLimiter, callRoutes);
app.use('/api/analysis', apiLimiter, analysisRoutes);
app.use('/api/prompts', apiLimiter, promptRoutes);

// Active call pipelines — keyed by callId
const activePipelines = new Map<string, AgentPipeline>();

// Socket connection throttle: max 5 concurrent sockets per IP
const socketIpCount = new Map<string, number>();

io.on('connection', (socket) => {
  // Track connections per IP and reject excessive ones
  const clientIp = (socket.handshake.headers['x-forwarded-for'] as string || socket.handshake.address).split(',')[0].trim();
  const currentCount = socketIpCount.get(clientIp) || 0;
  if (currentCount >= 5) {
    logger.warn(`Socket connection rejected (too many from ${clientIp})`);
    socket.emit('call:error', { message: 'Too many connections from this IP' });
    socket.disconnect(true);
    return;
  }
  socketIpCount.set(clientIp, currentCount + 1);
  socket.on('disconnect', () => {
    const count = (socketIpCount.get(clientIp) || 1) - 1;
    if (count <= 0) socketIpCount.delete(clientIp);
    else socketIpCount.set(clientIp, count);
  });
  logger.info(`Client connected: ${socket.id} from ${clientIp}`);
  let activePipeline: AgentPipeline | null = null;
  let activeCallId: string | null = null;

  socket.on('call:start', async (data: { callId: string }) => {
    const { callId } = data;
    activeCallId = callId;

    try {
      const { systemPrompt, version } = await getCurrentPrompt();
      const roomName = `novatek-call-${callId}`;
      const pipeline = new AgentPipeline(socket, callId, systemPrompt, roomName);
      activePipelines.set(callId, pipeline);
      activePipeline = pipeline;

      await pipeline.start();

      socket.emit('call:started', { callId, promptVersion: version });
      logger.info(`Call started: ${callId} (prompt v${version})`);
    } catch (err) {
      logger.error('Failed to start agent pipeline', err);
      let clientMsg = 'Failed to start voice agent';
      if (err instanceof Error) {
        const errStr = err.message || '';
        if (errStr.includes('503') || errStr.includes('UNAVAILABLE') || errStr.includes('high demand')) {
          clientMsg = 'Gemini LLM is currently experiencing high demand. Please try again in a few moments.';
        } else if (errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED')) {
          clientMsg = 'Gemini LLM rate limit exceeded. Please try again shortly.';
        } else if (errStr.includes('API key') || errStr.includes('API_KEY_INVALID') || errStr.includes('400')) {
          clientMsg = 'Gemini LLM: Invalid API Key. Please check your credentials.';
        } else if (errStr) {
          clientMsg = `Failed to start voice agent: ${err.message}`;
        }
      }
      socket.emit('call:error', { message: clientMsg });
    }
  });


  const handleCallTermination = async (callId: string, pipeline: AgentPipeline) => {
    const endTime = new Date();
    let duration = 0;

    try {
      const callDoc = await Call.findOne({ callId });
      if (callDoc) {
        duration = Math.floor((endTime.getTime() - callDoc.startTime.getTime()) / 1000);
      }
    } catch { /* ignore */ }

    const audioFile = await pipeline.stop();
    const turns = pipeline.getTurns();
    const deadAirSegments = pipeline.getDeadAirSegments();

    try {
      await Call.findOneAndUpdate(
        { callId },
        { status: 'completed', endTime, duration, audioFile: audioFile || undefined }
      );
    } catch (dbErr) {
      logger.error(`Failed to update call database status for ${callId}`, dbErr);
    }

    if (socket.connected) {
      socket.emit('call:ended', { callId, duration, audioFile });
    }
    logger.info(`Call terminated: ${callId} — ${duration}s, ${turns.length} turns`);

    // Async: analyze the call and trigger self-healing if turns were completed
    if (turns.length > 0) {
      setImmediate(async () => {
        try {
          const callDoc = await Call.findOne({ callId });
          const promptVersion = callDoc?.agentPromptVersion || 1;

          if (socket.connected) {
            socket.emit('analysis:started');
          }

          const analysis = await runCallAnalysis(
            callId,
            turns,
            duration,
            deadAirSegments,
            promptVersion
          );

          if (analysis) {
            if (socket.connected) {
              socket.emit('analysis:complete', { callId, scorecard: analysis });
            }

            // Self-healing: generate patch if score is below threshold
            const patch = await generateAndApplyPatch(
              callId,
              (analysis as any).rubric_score,
              (analysis as any).failure_moments || [],
              turns
            );

            if (patch && socket.connected) {
              socket.emit('prompt:evolved', patch);
            }
          } else {
            if (socket.connected) {
              socket.emit('analysis:error', { message: 'Call transcript too short to analyze' });
            }
          }

          // Cleanup LiveKit room
          if (callDoc?.roomName) {
            await deleteRoom(callDoc.roomName);
          }
        } catch (err: unknown) {
          logger.error('Post-call processing failed', err);
          let clientMsg = 'Analysis failed';
          const errStr = err instanceof Error ? err.message : '';
          if (errStr.includes('503') || errStr.includes('UNAVAILABLE') || errStr.includes('high demand')) {
            clientMsg = 'Analysis failed: Gemini LLM is currently experiencing high demand. Please try again later.';
          } else if (errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED')) {
            clientMsg = 'Analysis failed: Gemini LLM rate limit exceeded.';
          } else if (errStr) {
            clientMsg = `Analysis failed: ${errStr.slice(0, 100)}`;
          }

          if (socket.connected) {
            socket.emit('analysis:error', { message: clientMsg });
          }
        }
      });
    } else {
      // Empty call, just cleanup LiveKit room immediately
      try {
        const callDoc = await Call.findOne({ callId });
        if (callDoc?.roomName) {
          await deleteRoom(callDoc.roomName);
        }
      } catch {}
    }
  };

  socket.on('call:end', async () => {
    if (!activePipeline || !activeCallId) return;

    const callId = activeCallId;
    const pipeline = activePipeline;
    // Clear refs BEFORE async work to prevent double-termination
    activePipeline = null;
    activeCallId = null;
    activePipelines.delete(callId);

    try {
      await handleCallTermination(callId, pipeline);
    } catch (err) {
      logger.error(`Unhandled error in call:end for ${callId}`, err);
    }
  });

  // Note: the IP-tracking disconnect handler is registered above in the connection block.
  // This handler handles call cleanup on unexpected disconnects.
  socket.on('disconnect', async (reason) => {
    logger.info(`Client disconnected: ${socket.id} (reason: ${reason})`);
    if (activePipeline && activeCallId) {
      const callId = activeCallId;
      const pipeline = activePipeline;
      // Clear refs BEFORE async work to prevent double-termination
      activePipeline = null;
      activeCallId = null;
      activePipelines.delete(callId);

      try {
        await handleCallTermination(callId, pipeline);
      } catch (err) {
        logger.error(`Unhandled error in disconnect handler for ${callId}`, err);
      }
    }
  });
});

async function start() {
  await connectDatabase();
  await seedInitialPrompt();

  // --- Global Express error handlers (must be registered after all routes) ---

  // 404 catch-all: any API path not matched by routes
  app.use((_req, res) => {
    res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND', status: 404 });
  });

  // Global Express error handler (4-argument signature required by Express)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled Express error', err);
    const message = err instanceof Error ? err.message : 'Internal server error';
    res.status(500).json({ error: message, code: 'INTERNAL_ERROR', status: 500 });
  });

  httpServer.listen(config.port, () => {
    logger.info(`Server running on port ${config.port}`);
    logger.info(`Client URL: ${config.clientUrl}`);
  });
}

// --- Process-level error guards ---
// Prevent silent crashes from unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', { reason, promise });
  // Do NOT exit — log and continue. The offending request will time out.
});

// Catch truly unexpected exceptions — log and exit gracefully
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception — shutting down', err);
  process.exit(1);
});

start().catch((err) => {
  logger.error('Server startup failed', err);
  process.exit(1);
});

