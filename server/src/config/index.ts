import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

const possiblePaths = [
  path.join(__dirname, '../../../.env'), // dev mode: project root
  path.join(__dirname, '../../../../.env'), // dist/production mode: project root
  path.join(process.cwd(), '.env'), // current working directory
  path.join(process.cwd(), '../.env'), // parent of current working directory
];

for (const envPath of possiblePaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

// Support comma-separated origins so a single deploy can serve both the Vercel
// production URL and a localhost dev frontend (or preview URLs).
// Example: CLIENT_URL="https://novatel.vercel.app,http://localhost:5173"
const rawClientUrl = optional('CLIENT_URL', 'http://localhost:5173');
const clientOrigins = rawClientUrl.split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  port: parseInt(optional('PORT', '3001')),
  // Single string when one origin (back-compat); array when multiple.
  clientUrl: clientOrigins.length > 1 ? clientOrigins : clientOrigins[0],
  clientOrigins,
  nodeEnv: optional('NODE_ENV', 'development'),

  livekit: {
    url: optional('LIVEKIT_URL', ''),
    apiKey: optional('LIVEKIT_API_KEY', ''),
    apiSecret: optional('LIVEKIT_API_SECRET', ''),
  },

  deepgram: {
    apiKey: optional('DEEPGRAM_API_KEY', ''),
  },

  gemini: {
    apiKey: optional('GEMINI_API_KEY', ''),
    model: optional('GEMINI_MODEL', 'gemini-2.5-flash'),
  },


  mongodb: {
    uri: optional('MONGODB_URI', 'mongodb://localhost:27017/novatek-voice'),
  },

  uploads: {
    // Resolve UPLOADS_DIR against the project root (server/src/config -> ../../..).
    // Default keeps recordings inside the project at <root>/uploads/recordings.
    // Absolute paths in the env var are honored as-is.
    dir: path.resolve(__dirname, '../../..', optional('UPLOADS_DIR', 'uploads/recordings')),
  },
};
