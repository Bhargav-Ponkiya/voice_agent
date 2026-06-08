import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createUserToken } from '../services/livekit/roomService';
import { getCurrentPrompt } from '../services/promptEvolution/selfHealingPrompt';
import { Call } from '../database/models/Call';
import { config } from '../config';
import { logger } from '../utils/logger';
import { sendError, ErrorCode } from '../utils/errorResponse';

const router = Router();

/** Validate that a string is a properly-formatted UUID v4 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

/**
 * POST /api/calls/start
 * Creates a new call session, provisions a LiveKit room, and returns connection tokens.
 */
router.post('/start', async (req: Request, res: Response) => {
  try {
    const callId = uuidv4();
    const roomName = `novatek-call-${callId}`;

    const { version } = await getCurrentPrompt();
    const userToken = await createUserToken(roomName, `customer-${callId.slice(0, 8)}`);

    await Call.create({
      callId,
      roomName,
      startTime: new Date(),
      agentPromptVersion: version,
      status: 'active',
    });

    res.json({
      callId,
      roomName,
      userToken,
      livekitUrl: config.livekit.url,
      promptVersion: version,
    });
  } catch (err) {
    logger.error('Failed to start call', err);
    sendError(res, 500, 'Failed to start call — please try again', ErrorCode.CALL_START_FAILED);
  }
});

/**
 * GET /api/calls
 * Returns the 20 most recent completed calls for the dashboard history list.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const calls = await Call.find({ status: 'completed' })
      .sort({ startTime: -1 })
      .limit(20)
      .lean();
    res.json(calls);
  } catch (err) {
    logger.error('Failed to fetch calls', err);
    sendError(res, 500, 'Failed to fetch call history', ErrorCode.CALL_FETCH_FAILED);
  }
});

/**
 * GET /api/calls/:callId
 * Returns a single call record by its UUID.
 */
router.get('/:callId', async (req: Request, res: Response) => {
  if (!isValidUuid(req.params.callId)) {
    return sendError(res, 400, 'Invalid call ID format — must be a valid UUID', ErrorCode.INVALID_CALL_ID);
  }
  try {
    const call = await Call.findOne({ callId: req.params.callId }).lean();
    if (!call) return sendError(res, 404, 'Call not found', ErrorCode.CALL_NOT_FOUND);
    res.json(call);
  } catch (err) {
    logger.error(`Failed to fetch call ${req.params.callId}`, err);
    sendError(res, 500, 'Failed to fetch call details', ErrorCode.CALL_FETCH_FAILED);
  }
});

export default router;
