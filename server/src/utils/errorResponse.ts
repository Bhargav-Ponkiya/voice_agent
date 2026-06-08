import { Response } from 'express';

/**
 * Machine-readable error codes for the frontend to key on.
 * Avoids string-matching error messages across client/server.
 */
export const ErrorCode = {
  // Call errors
  CALL_NOT_FOUND: 'CALL_NOT_FOUND',
  CALL_START_FAILED: 'CALL_START_FAILED',
  CALL_FETCH_FAILED: 'CALL_FETCH_FAILED',

  // Analysis errors
  ANALYSIS_NOT_FOUND: 'ANALYSIS_NOT_FOUND',
  TRANSCRIPT_NOT_FOUND: 'TRANSCRIPT_NOT_FOUND',
  ANALYSIS_FETCH_FAILED: 'ANALYSIS_FETCH_FAILED',

  // Prompt errors
  PROMPT_NOT_FOUND: 'PROMPT_NOT_FOUND',
  PROMPT_FETCH_FAILED: 'PROMPT_FETCH_FAILED',

  // Validation errors
  INVALID_CALL_ID: 'INVALID_CALL_ID',
  INVALID_VERSION: 'INVALID_VERSION',

  // Rate limiting
  RATE_LIMITED: 'RATE_LIMITED',

  // Server errors
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCodeType = typeof ErrorCode[keyof typeof ErrorCode];

export interface ApiErrorBody {
  error: string;
  code: ErrorCodeType;
  status: number;
}

/**
 * Send a consistent, structured JSON error response.
 * Every API error uses this format so the frontend can rely on it.
 *
 * @param res     Express Response object
 * @param status  HTTP status code
 * @param message Human-readable error description
 * @param code    Machine-readable error code (default: INTERNAL_ERROR)
 */
export function sendError(
  res: Response,
  status: number,
  message: string,
  code: ErrorCodeType = ErrorCode.INTERNAL_ERROR
): void {
  const body: ApiErrorBody = { error: message, code, status };
  res.status(status).json(body);
}
