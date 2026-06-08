import fs from 'fs';
import path from 'path';

type Level = 'info' | 'warn' | 'error' | 'debug';

const LEVEL_ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

// Production defaults to warn-and-above to keep cloud log dashboards readable.
// Override at runtime with LOG_LEVEL=debug|info|warn|error.
// File logging is disabled in production by default (cloud hosts capture stdout).
const isProd = process.env.NODE_ENV === 'production';
const envLevel = (process.env.LOG_LEVEL || (isProd ? 'warn' : 'info')).toLowerCase() as Level;
const MIN_LEVEL = LEVEL_ORDER[envLevel] !== undefined ? LEVEL_ORDER[envLevel] : LEVEL_ORDER.info;
const FILE_LOGGING = process.env.LOG_TO_FILE === '1' || !isProd;

const logDir = path.join(__dirname, '../../logs');
const logFile = path.join(logDir, 'pipeline.log');

if (FILE_LOGGING) {
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch { /* ignore */ }
}

function log(level: Level, message: string, meta?: unknown) {
  if (LEVEL_ORDER[level] < MIN_LEVEL) return;

  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;

  // Console logging — always goes through; cloud hosts capture stdout/stderr.
  if (meta !== undefined) {
    console[level === 'debug' ? 'log' : level](`${prefix} ${message}`, meta);
  } else {
    console[level === 'debug' ? 'log' : level](`${prefix} ${message}`);
  }

  // File logging — async appendFile (NOT appendFileSync). Hot paths log dozens of lines
  // per second; sync disk I/O on every call blocks the event loop and degrades latency.
  if (!FILE_LOGGING) return;

  let logLine = `${prefix} ${message}`;
  if (meta !== undefined) {
    if (meta instanceof Error) {
      logLine += `\n[Stack Trace]\n${meta.stack || meta.message}`;
    } else {
      try {
        logLine += `\n[Meta] ${JSON.stringify(meta, null, 2)}`;
      } catch {
        logLine += `\n[Meta] ${String(meta)}`;
      }
    }
  }
  logLine += '\n';

  fs.appendFile(logFile, logLine, () => {
    // Best-effort — never let a log write failure crash the request path.
  });
}

export const logger = {
  info: (msg: string, meta?: unknown) => log('info', msg, meta),
  warn: (msg: string, meta?: unknown) => log('warn', msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
  debug: (msg: string, meta?: unknown) => log('debug', msg, meta),
};
