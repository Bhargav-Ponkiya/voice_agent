import axios, { AxiosError } from 'axios';
import { CallRecord, Scorecard, PromptVersion } from '../types';

const apiBaseUrl = import.meta.env.VITE_API_URL ? `${import.meta.env.VITE_API_URL}/api` : '/api';

const api = axios.create({
  baseURL: apiBaseUrl,
  timeout: 15_000, // 15s timeout on all API calls
});

// ─── Typed API Error ────────────────────────────────────────────────────────

/**
 * All API errors are normalized into this shape, matching the server's
 * { error, code, status } response structure.
 */
export interface ApiError {
  message: string;  // Human-readable message shown in the UI
  code: string;     // Machine-readable code for conditional logic
  status: number;   // HTTP status code
}

/** Type guard to check if a thrown value is a normalized ApiError */
export function isApiError(err: unknown): err is ApiError {
  return (
    typeof err === 'object' &&
    err !== null &&
    'message' in err &&
    'code' in err &&
    'status' in err
  );
}

// ─── Response Interceptor ───────────────────────────────────────────────────

/**
 * Normalize every Axios error into a consistent ApiError so callers
 * never need to access .response.data.error themselves.
 */
api.interceptors.response.use(
  (response) => response,
  (error: AxiosError<{ error?: string; code?: string; status?: number }>) => {
    const data = error.response?.data;
    const status = error.response?.status ?? 0;

    const normalized: ApiError = {
      message:
        data?.error ||
        error.message ||
        'An unexpected error occurred. Please try again.',
      code: data?.code || 'UNKNOWN_ERROR',
      status,
    };

    // Network error (no response at all)
    if (!error.response) {
      normalized.message = 'Cannot reach the server — check your network connection.';
      normalized.code = 'NETWORK_ERROR';
    }

    // Rate limited
    if (status === 429) {
      normalized.message = 'Too many requests — please wait a moment before trying again.';
    }

    return Promise.reject(normalized);
  }
);

// ─── API Functions ──────────────────────────────────────────────────────────

export async function startCall(): Promise<{
  callId: string;
  roomName: string;
  userToken: string;
  livekitUrl: string;
  promptVersion: number;
}> {
  const res = await api.post('/calls/start');
  return res.data;
}

export async function getCalls(): Promise<CallRecord[]> {
  const res = await api.get('/calls');
  return res.data;
}

export async function getCall(callId: string): Promise<CallRecord> {
  const res = await api.get(`/calls/${callId}`);
  return res.data;
}

export async function getAnalysis(callId: string): Promise<Scorecard> {
  const res = await api.get(`/analysis/${callId}`);
  return res.data;
}

export async function getAllAnalyses(): Promise<Scorecard[]> {
  const res = await api.get('/analysis');
  return res.data;
}

export async function getTranscript(callId: string): Promise<{ turns: any[] }> {
  const res = await api.get(`/analysis/${callId}/transcript`);
  return res.data;
}

export async function getPromptVersions(): Promise<PromptVersion[]> {
  const res = await api.get('/prompts');
  return res.data;
}

export async function getCurrentPrompt(): Promise<PromptVersion> {
  const res = await api.get('/prompts/current');
  return res.data;
}

export default api;
