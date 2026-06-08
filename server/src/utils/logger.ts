import fs from 'fs';
import path from 'path';

type Level = 'info' | 'warn' | 'error' | 'debug';

const logDir = path.join(__dirname, '../../logs');
const logFile = path.join(logDir, 'pipeline.log');

try {
  fs.mkdirSync(logDir, { recursive: true });
} catch { /* ignore */ }

function log(level: Level, message: string, meta?: unknown) {
  const ts = new Date().toISOString();
  const prefix = `[${ts}] [${level.toUpperCase()}]`;

  // Console logging
  if (meta) {
    console[level === 'debug' ? 'log' : level](`${prefix} ${message}`, meta);
  } else {
    console[level === 'debug' ? 'log' : level](`${prefix} ${message}`);
  }

  // File logging
  let logLine = `${prefix} ${message}`;
  if (meta !== undefined) {
    if (meta instanceof Error) {
      logLine += `\n[Stack Trace]\n${meta.stack || meta.message}`;
    } else {
      try {
        logLine += `\n[Meta] ${JSON.stringify(meta, null, 2)}`;
      } catch {
        logLine += `\n[Meta] ${meta}`;
      }
    }
  }
  logLine += '\n';

  try {
    fs.appendFileSync(logFile, logLine);
  } catch (err) {
    // Prevent logging failures from affecting application runtime
  }
}

export const logger = {
  info: (msg: string, meta?: unknown) => log('info', msg, meta),
  warn: (msg: string, meta?: unknown) => log('warn', msg, meta),
  error: (msg: string, meta?: unknown) => log('error', msg, meta),
  debug: (msg: string, meta?: unknown) => {
    if (process.env.NODE_ENV !== 'production') log('debug', msg, meta);
  },
};
