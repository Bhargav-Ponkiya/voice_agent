import { Router, Request, Response } from 'express';
import { PromptVersion } from '../database/models/PromptVersion';
import { logger } from '../utils/logger';
import { sendError, ErrorCode } from '../utils/errorResponse';

const router = Router();

/**
 * GET /api/prompts
 * Returns all prompt versions in descending order (latest first).
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const versions = await PromptVersion.find()
      .sort({ version: -1 })
      .lean();
    res.json(versions);
  } catch (err) {
    logger.error('Failed to fetch prompt versions', err);
    sendError(res, 500, 'Failed to fetch prompt version history', ErrorCode.PROMPT_FETCH_FAILED);
  }
});

/**
 * GET /api/prompts/current
 * Returns the latest active prompt version used by the agent.
 */
router.get('/current', async (_req: Request, res: Response) => {
  try {
    const latest = await PromptVersion.findOne().sort({ version: -1 }).lean();
    if (!latest) return sendError(res, 404, 'No prompt versions found', ErrorCode.PROMPT_NOT_FOUND);
    res.json(latest);
  } catch (err) {
    logger.error('Failed to fetch current prompt', err);
    sendError(res, 500, 'Failed to fetch current prompt', ErrorCode.PROMPT_FETCH_FAILED);
  }
});

/**
 * GET /api/prompts/:version
 * Returns a specific prompt version by its version number.
 */
router.get('/:version', async (req: Request, res: Response) => {
  const version = parseInt(req.params.version, 10);
  if (isNaN(version) || version < 1) {
    return sendError(res, 400, 'Invalid version number — must be a positive integer', ErrorCode.INVALID_VERSION);
  }
  try {
    const prompt = await PromptVersion.findOne({ version }).lean();
    if (!prompt) return sendError(res, 404, `Prompt version ${version} not found`, ErrorCode.PROMPT_NOT_FOUND);
    res.json(prompt);
  } catch (err) {
    logger.error(`Failed to fetch prompt v${req.params.version}`, err);
    sendError(res, 500, 'Failed to fetch prompt version', ErrorCode.PROMPT_FETCH_FAILED);
  }
});

export default router;
