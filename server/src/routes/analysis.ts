import { Router, Request, Response } from 'express';
import { Analysis } from '../database/models/Analysis';
import { Transcript } from '../database/models/Transcript';
import { logger } from '../utils/logger';
import { sendError, ErrorCode } from '../utils/errorResponse';

const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUuid(id: string): boolean {
  return UUID_REGEX.test(id);
}

/**
 * GET /api/analysis
 * Returns the 20 most recent call analyses, sorted by creation time descending.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const analyses = await Analysis.find()
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json(analyses);
  } catch (err) {
    logger.error('Failed to fetch analyses', err);
    sendError(res, 500, 'Failed to fetch analysis history', ErrorCode.ANALYSIS_FETCH_FAILED);
  }
});

/**
 * GET /api/analysis/:callId
 * Returns the QA scorecard for a specific call.
 */
router.get('/:callId', async (req: Request, res: Response) => {
  if (!isValidUuid(req.params.callId)) {
    return sendError(res, 400, 'Invalid call ID format — must be a valid UUID', ErrorCode.INVALID_CALL_ID);
  }
  try {
    const analysis = await Analysis.findOne({ callId: req.params.callId }).lean();
    if (!analysis) return sendError(res, 404, 'Analysis not found for this call', ErrorCode.ANALYSIS_NOT_FOUND);
    res.json(analysis);
  } catch (err) {
    logger.error(`Failed to fetch analysis for ${req.params.callId}`, err);
    sendError(res, 500, 'Failed to fetch call analysis', ErrorCode.ANALYSIS_FETCH_FAILED);
  }
});

/**
 * GET /api/analysis/:callId/transcript
 * Returns the raw conversation transcript for a specific call.
 */
router.get('/:callId/transcript', async (req: Request, res: Response) => {
  if (!isValidUuid(req.params.callId)) {
    return sendError(res, 400, 'Invalid call ID format — must be a valid UUID', ErrorCode.INVALID_CALL_ID);
  }
  try {
    const transcript = await Transcript.findOne({ callId: req.params.callId }).lean();
    if (!transcript) return sendError(res, 404, 'Transcript not found for this call', ErrorCode.TRANSCRIPT_NOT_FOUND);
    res.json(transcript);
  } catch (err) {
    logger.error(`Failed to fetch transcript for ${req.params.callId}`, err);
    sendError(res, 500, 'Failed to fetch call transcript', ErrorCode.ANALYSIS_FETCH_FAILED);
  }
});

export default router;
