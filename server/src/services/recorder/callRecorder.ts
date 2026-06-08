import path from 'path';
import fs from 'fs';
import { config } from '../../config';
import { writeWavFile } from '../../utils/audioUtils';
import { logger } from '../../utils/logger';

/**
 * CallRecorder streams raw PCM audio directly to temp files on disk during the call,
 * avoiding the RAM accumulation that comes from holding Buffer[] arrays in memory.
 * At finalize(), temp PCM data is wrapped with WAV headers and saved to the final path.
 */
export class CallRecorder {
  private callId: string;

  // Temp PCM file paths (written during call)
  private customerTempPath: string;
  private agentTempPath: string;

  // Writable streams to temp files
  private customerStream: fs.WriteStream | null = null;
  private agentStream: fs.WriteStream | null = null;

  // Track whether any audio was written
  private hasCustomerAudio = false;
  private hasAgentAudio = false;

  private readonly SAMPLE_RATE = 16000;
  
  // Audio mixing fields
  private startTime: number = Date.now();
  private customerBytesWritten = 0;
  private agentBytesWritten = 0;

  constructor(callId: string) {
    this.callId = callId;
    this.customerTempPath = path.join(config.uploads.dir, `_tmp_${callId}_customer.pcm`);
    this.agentTempPath = path.join(config.uploads.dir, `_tmp_${callId}_agent.pcm`);
  }

  private getCustomerStream(): fs.WriteStream {
    if (!this.customerStream) {
      this.customerStream = fs.createWriteStream(this.customerTempPath, { flags: 'w' });
    }
    return this.customerStream;
  }

  private getAgentStream(): fs.WriteStream {
    if (!this.agentStream) {
      this.agentStream = fs.createWriteStream(this.agentTempPath, { flags: 'w' });
    }
    return this.agentStream;
  }

  private padWithSilence(stream: fs.WriteStream, currentBytes: number): number {
    const elapsedMs = Date.now() - this.startTime;
    const expectedBytes = Math.floor((elapsedMs / 1000) * this.SAMPLE_RATE * 2);
    
    if (currentBytes < expectedBytes) {
      const missing = expectedBytes - currentBytes;
      const padding = missing - (missing % 2); // even for 16-bit
      if (padding > 0) {
        stream.write(Buffer.alloc(padding));
        return currentBytes + padding;
      }
    }
    return currentBytes;
  }

  addCustomerAudio(chunk: Buffer): void {
    try {
      const stream = this.getCustomerStream();
      this.customerBytesWritten = this.padWithSilence(stream, this.customerBytesWritten);
      stream.write(chunk);
      this.customerBytesWritten += chunk.length;
      this.hasCustomerAudio = true;
    } catch (err) {
      logger.error('Failed to write customer audio chunk', err);
    }
  }

  addAgentAudio(chunk: Buffer): void {
    try {
      const stream = this.getAgentStream();
      this.agentBytesWritten = this.padWithSilence(stream, this.agentBytesWritten);
      stream.write(chunk);
      this.agentBytesWritten += chunk.length;
      this.hasAgentAudio = true;
    } catch (err) {
      logger.error('Failed to write agent audio chunk', err);
    }
  }

  async finalize(): Promise<string | null> {
    // Pad to current time before closing
    if (this.hasCustomerAudio && this.customerStream) {
      this.customerBytesWritten = this.padWithSilence(this.customerStream, this.customerBytesWritten);
    }
    if (this.hasAgentAudio && this.agentStream) {
      this.agentBytesWritten = this.padWithSilence(this.agentStream, this.agentBytesWritten);
    }

    // Close open streams before reading the temp files
    await this.closeStreams();

    try {
      const fileName = `call_${this.callId}_${Date.now()}.wav`;
      const basePath = path.join(config.uploads.dir, fileName);

      let customerBuf: Buffer | null = null;
      let agentBuf: Buffer | null = null;

      if (this.hasCustomerAudio) {
        customerBuf = fs.readFileSync(this.customerTempPath);
        writeWavFile(basePath.replace('.wav', '_customer.wav'), [customerBuf], this.SAMPLE_RATE, 1, 16);
      }

      if (this.hasAgentAudio) {
        agentBuf = fs.readFileSync(this.agentTempPath);
        writeWavFile(basePath.replace('.wav', '_agent.wav'), [agentBuf], this.SAMPLE_RATE, 1, 16);
      }

      // Mix them into the primary file
      if (customerBuf && agentBuf) {
        const { mergeAudioChannels } = await import('../../utils/audioUtils');
        const mixed = mergeAudioChannels([customerBuf], [agentBuf], this.SAMPLE_RATE);
        writeWavFile(basePath, mixed, this.SAMPLE_RATE, 1, 16);
      } else if (customerBuf) {
        writeWavFile(basePath, [customerBuf], this.SAMPLE_RATE, 1, 16);
      } else if (agentBuf) {
        writeWavFile(basePath, [agentBuf], this.SAMPLE_RATE, 1, 16);
      }

      // Cleanup temp PCM files
      try {
        if (fs.existsSync(this.customerTempPath)) fs.unlinkSync(this.customerTempPath);
        if (fs.existsSync(this.agentTempPath)) fs.unlinkSync(this.agentTempPath);
      } catch (err) {
        logger.warn('Failed to delete temp PCM files', err);
      }

      logger.info(`Call recording saved: ${fileName}`);
      return fileName;
    } catch (err) {
      logger.error('Failed to finalize call audio', err);
      return null;
    } finally {
      // Always clean up temp PCM files
      this.cleanupTempFiles();
    }
  }

  private closeStreams(): Promise<void> {
    return new Promise((resolve) => {
      let pending = 0;
      const done = () => { if (--pending === 0) resolve(); };

      if (this.customerStream) {
        pending++;
        this.customerStream.end(done);
        this.customerStream = null;
      }
      if (this.agentStream) {
        pending++;
        this.agentStream.end(done);
        this.agentStream = null;
      }
      if (pending === 0) resolve();
    });
  }

  private cleanupTempFiles(): void {
    for (const p of [this.customerTempPath, this.agentTempPath]) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch {
        // Best-effort cleanup — not critical
      }
    }
  }
}
