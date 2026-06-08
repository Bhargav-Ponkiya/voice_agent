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

function required(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required environment variable: ${name}`);
  return val;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  port: parseInt(optional('PORT', '3001')),
  clientUrl: optional('CLIENT_URL', 'http://localhost:5173'),
  nodeEnv: optional('NODE_ENV', 'development'),

  livekit: {
    url: optional('LIVEKIT_URL', ''),
    apiKey: optional('LIVEKIT_API_KEY', ''),
    apiSecret: optional('LIVEKIT_API_SECRET', ''),
  },

  deepgram: {
    apiKey: optional('DEEPGRAM_API_KEY', ''),
  },

  anthropic: {
    apiKey: optional('ANTHROPIC_API_KEY', ''),
    model: optional('ANTHROPIC_MODEL', 'claude-haiku-4-5-20251001'),
  },

  gemini: {
    apiKey: optional('GEMINI_API_KEY', ''),
    model: optional('GEMINI_MODEL', 'gemini-2.5-flash'),
  },


  mongodb: {
    uri: optional('MONGODB_URI', 'mongodb://localhost:27017/novatek-voice'),
  },

  uploads: {
    dir: path.resolve(__dirname, '../../..', optional('UPLOADS_DIR', '../uploads/recordings')),
  },
};
