import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export interface DeepgramTranscript {
  text: string;
  isFinal: boolean;
  confidence: number;
  words: Array<{ word: string; start: number; end: number; confidence: number }>;
}

export class DeepgramSTT extends EventEmitter {
  private ws: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private isConnected = false;
  private isClosed = false;
  private pendingAudio: Buffer[] = [];
  private droppedChunkCount = 0;
  /** Max buffered chunks while waiting for connection (prevents unbounded memory use) */
  private static readonly MAX_PENDING_CHUNKS = 50;

  connect(): void {
    if (this.isClosed) {
      logger.warn('[DeepgramSTT] connect() called after close() — ignoring');
      return;
    }
    const url = new URL('wss://api.deepgram.com/v1/listen');
    url.searchParams.set('model', 'nova-2');
    url.searchParams.set('language', 'en-US');
    url.searchParams.set('smart_format', 'true');
    url.searchParams.set('interim_results', 'true');
    url.searchParams.set('endpointing', '300');
    url.searchParams.set('vad_events', 'true');
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', '16000');
    url.searchParams.set('channels', '1');

    this.ws = new WebSocket(url.toString(), {
      headers: { Authorization: `Token ${config.deepgram.apiKey}` },
    });

    this.ws.on('open', () => {
      this.isConnected = true;
      logger.debug('Deepgram STT connected');
      // flush pending audio
      for (const chunk of this.pendingAudio) {
        this.ws?.send(chunk);
      }
      this.pendingAudio = [];

      // Start keep-alive interval (Deepgram shuts idle connections down if silent for 10s. We send keep-alive every 3s to stay well within bounds)
      this.keepAliveTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 3000);
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'Results') {
          const alt = msg.channel?.alternatives?.[0];
          if (!alt) return;

          const transcript: DeepgramTranscript = {
            text: alt.transcript || '',
            isFinal: msg.is_final === true,
            confidence: alt.confidence || 0,
            words: alt.words || [],
          };

          if (transcript.text.trim()) {
            this.emit('transcript', transcript);
          }
        }

        if (msg.type === 'SpeechStarted') {
          this.emit('speech_started');
        }

        if (msg.type === 'UtteranceEnd') {
          this.emit('utterance_end');
        }
      } catch {
        // ignore parse errors
      }
    });

    this.ws.on('error', (err) => {
      logger.error('Deepgram STT error', err);
      this.emit('error', err);
    });

    this.ws.on('close', (code, reason) => {
      this.isConnected = false;
      if (this.keepAliveTimer) {
        clearInterval(this.keepAliveTimer);
        this.keepAliveTimer = null;
      }
      const reasonStr = reason.toString() || 'No reason provided';
      logger.info(`Deepgram STT disconnected. Code: ${code}, Reason: ${reasonStr}`);
      this.emit('close');

      // Auto-reconnect on unexpected close (not code 1000) — skip if we manually closed.
      if (code !== 1000 && !this.isClosed) {
        logger.info('Deepgram STT attempting reconnect in 2 seconds...');
        if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
          if (!this.isClosed) this.connect();
        }, 2000);
      }
    });
  }

  sendAudio(chunk: Buffer): void {
    if (this.isClosed) return;
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Cap pending buffer: drop oldest chunks if we hit the limit
      if (this.pendingAudio.length >= DeepgramSTT.MAX_PENDING_CHUNKS) {
        this.pendingAudio.shift();
        this.droppedChunkCount++;
        // Surface the drop periodically so a long STT outage is visible in logs and to the pipeline.
        if (this.droppedChunkCount === 1 || this.droppedChunkCount % 25 === 0) {
          logger.warn(`[DeepgramSTT] Dropping mic audio while disconnected — ${this.droppedChunkCount} chunk(s) lost so far`);
          this.emit('audio_dropped', { count: this.droppedChunkCount });
        }
      }
      this.pendingAudio.push(chunk);
      return;
    }
    this.ws.send(chunk);
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.on('error', () => {}); // prevent uncaught 'error' after close
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.isConnected = false;
    this.pendingAudio = [];
    // Drop EventEmitter consumers (agentPipeline registers 'transcript'/'speech_started'/'error')
    this.removeAllListeners();
  }
}
