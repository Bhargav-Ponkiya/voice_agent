import { Router, Request, Response } from 'express';
import mongoose from 'mongoose';

const router = Router();

/**
 * GET /api/health
 * Returns server readiness status.
 */
router.get('/', (_req: Request, res: Response) => {
  const mongoStatus = mongoose.connection.readyState;
  const mongoOk = mongoStatus === 1;

  const checks = {
    server: 'ok',
    mongodb: mongoOk ? 'connected' : 'disconnected',
    services: {
      livekit: !!(process.env.LIVEKIT_URL && process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET),
      deepgram: !!process.env.DEEPGRAM_API_KEY,
      gemini: !!process.env.GEMINI_API_KEY,
      mongodb: !!process.env.MONGODB_URI,
    },
    timestamp: new Date().toISOString(),
  };

  const allServicesConfigured = Object.values(checks.services).every(Boolean);
  const ready = allServicesConfigured && mongoOk;

  res.status(ready ? 200 : 503).json({ ...checks, ready });
});

export default router;

