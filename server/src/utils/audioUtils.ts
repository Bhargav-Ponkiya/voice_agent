import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';

export function int16ToFloat32(buffer: Buffer): Float32Array {
  const samples = buffer.length / 2;
  const float32 = new Float32Array(samples);
  for (let i = 0; i < samples; i++) {
    const int16 = buffer.readInt16LE(i * 2);
    float32[i] = int16 / 32768.0;
  }
  return float32;
}

function buildWavHeader(
  dataSize: number,
  sampleRate: number,
  channels: number,
  bitsPerSample: number
): Buffer {
  const byteRate = (sampleRate * channels * bitsPerSample) / 8;
  const blockAlign = (channels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

/**
 * Async WAV writer. Streams the header and PCM chunks directly to disk so we
 * don't allocate a second copy of (potentially multi-megabyte) PCM data.
 */
export async function writeWavFile(
  filePath: string,
  pcmChunks: Buffer[],
  sampleRate: number,
  channels: number,
  bitsPerSample: number
): Promise<void> {
  const dataSize = pcmChunks.reduce((acc, b) => acc + b.length, 0);
  const header = buildWavHeader(dataSize, sampleRate, channels, bitsPerSample);

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    out.on('error', reject);
    out.on('finish', resolve);
    out.write(header);
    for (const chunk of pcmChunks) out.write(chunk);
    out.end();
  });
}

export function mergeAudioChannels(
  channel1: Buffer[],
  channel2: Buffer[],
  sampleRate: number
): Buffer[] {
  const buf1 = Buffer.concat(channel1);
  const buf2 = Buffer.concat(channel2);
  const maxLen = Math.max(buf1.length, buf2.length);
  const merged = Buffer.alloc(maxLen);

  for (let i = 0; i < maxLen; i += 2) {
    const s1 = i < buf1.length ? buf1.readInt16LE(i) : 0;
    const s2 = i < buf2.length ? buf2.readInt16LE(i) : 0;
    const mixed = Math.max(-32768, Math.min(32767, Math.floor((s1 + s2) / 2)));
    merged.writeInt16LE(mixed, i);
  }

  return [merged];
}

export function formatTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `[${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}]`;
}
