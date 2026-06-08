import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { config } from '../../config';
import { logger } from '../../utils/logger';

export class DeepgramTTS extends EventEmitter {
  private ws: WebSocket | null = null;
  private isConnected = false;
  private isClosed = false;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;

  get connected(): boolean {
    return this.isConnected && this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    if (this.isClosed) {
      return Promise.reject(new Error('[DeepgramTTS] Connection requested after close() called'));
    }

    return new Promise((resolve, reject) => {
      if (!config.deepgram.apiKey) {
        reject(new Error('DEEPGRAM_API_KEY is not configured'));
        return;
      }

      if (this.connected) {
        resolve();
        return;
      }

      // Appending query parameters
      // Using aura-2-asteria-en (Asteria is highly recommended for speed and friendly female tone)
      const modelName = 'aura-2-asteria-en';
      // sample_rate=16000 must match LiveKit AudioSource(16000) in LiveKitTransport and
      // the recorder's 16kHz WAV format. The agent voice path is fully LiveKit-based:
      // Deepgram → livekitTransport.pushAgentAudio → LiveKit room → client <RoomAudioRenderer />.
      const url = `wss://api.deepgram.com/v1/speak?model=${modelName}&encoding=linear16&sample_rate=16000`;
      
      logger.info(`[DeepgramTTS] Connecting to WebSocket: wss://api.deepgram.com/v1/speak?model=${modelName}...`);

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Token ${config.deepgram.apiKey}`,
        },
      });

      let resolved = false;

      this.ws.on('open', () => {
        logger.info('[DeepgramTTS] WebSocket connection opened successfully');
        this.isConnected = true;
        
        // Start keep-alive interval: Deepgram shuts idle connections down if silent for 10s.
        // We send keep-alive every 3s to stay well within bounds.
        if (this.keepAliveTimer) {
          clearInterval(this.keepAliveTimer);
        }
        this.keepAliveTimer = setInterval(() => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            logger.info('[DeepgramTTS] Sending WebSocket ping to Deepgram');
            this.ws.ping();
          }
        }, 3000);

        resolved = true;
        resolve();
      });

      this.ws.on('message', (data: WebSocket.Data, isBinary: boolean) => {
        try {
          if (isBinary) {
            // Binary audio chunk from Deepgram
            const byteCount = Buffer.isBuffer(data) ? data.length : (data instanceof ArrayBuffer ? data.byteLength : 0);
            logger.info(`[DeepgramTTS] Received audio chunk: ${byteCount} bytes`);
            this.emit('audio', data);
          } else {
            // Text frame (JSON metadata or control)
            const textMsg = data.toString();
            try {
              const msg = JSON.parse(textMsg);
              logger.info(`[DeepgramTTS] Received control message: ${textMsg}`);
              
              if (msg.error) {
                logger.error(`[DeepgramTTS] API error response: ${textMsg}`);
                this.emit('error', new Error(`Deepgram TTS Error: ${msg.error}`));
              }
              if (msg.type === 'Warning') {
                logger.warn(`[DeepgramTTS] API warning: ${textMsg}`);
              }
              if (msg.type === 'Flushed') {
                logger.info('[DeepgramTTS] Received Flushed event from Deepgram');
                this.emit('flushed');
              }
            } catch {
              // Ignore non-JSON text
            }
          }
        } catch (err) {
          logger.error('[DeepgramTTS] Error parsing WebSocket message:', err);
        }
      });

      this.ws.on('error', (err) => {
        logger.error('[DeepgramTTS] WebSocket error event:', err);
        this.emit('error', err);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });

      this.ws.on('close', (code, reason) => {
        const reasonStr = reason.toString() || 'No reason provided';
        this.isConnected = false;
        
        if (this.keepAliveTimer) {
          clearInterval(this.keepAliveTimer);
          this.keepAliveTimer = null;
        }

        if (code === 1000) {
          logger.info(`[DeepgramTTS] WebSocket closed normally. Code: ${code}, Reason: ${reasonStr}`);
        } else {
          logger.warn(`[DeepgramTTS] WebSocket closed unexpectedly. Code: ${code}, Reason: ${reasonStr}`);
        }
        this.emit('close');

        if (!resolved) {
          resolved = true;
          reject(new Error(`[DeepgramTTS] WebSocket closed during connection: ${reasonStr}`));
        }

        // Auto-reconnect on unexpected close (not code 1000) and if we haven't manually closed it
        if (!this.isClosed && code !== 1000) {
          logger.info('[DeepgramTTS] Attempting to reconnect in 2 seconds...');
          if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch((err) => {
              logger.error('[DeepgramTTS] Auto-reconnection failed:', err);
            });
          }, 2000);
        }
      });
    });
  }

  sendText(text: string): void {
    logger.info(`[DeepgramTTS] sendText called: text="${text}"`);
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn(`[DeepgramTTS] sendText warning: not connected. isConnected=${this.isConnected}, readyState=${this.ws ? this.ws.readyState : 'null'}`);
      return;
    }
    const payload = JSON.stringify({
      type: 'Speak',
      text,
    });
    this.ws.send(payload);
    logger.info('[DeepgramTTS] Sent text payload to Deepgram');
  }

  flush(): void {
    logger.info('[DeepgramTTS] flush() called, sending Flush message to Deepgram');
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'Flush' }));
    logger.info('[DeepgramTTS] Sent Flush message to Deepgram');
  }

  clear(): void {
    logger.info('[DeepgramTTS] clear() called, sending Clear message to Deepgram');
    if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'Clear' }));
    logger.info('[DeepgramTTS] Sent Clear message to Deepgram');
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.on('error', () => {}); // Dummy handler to prevent uncaught throw
        this.ws.close();
      } catch { /* ignore */ }
      this.ws = null;
    }
    this.isConnected = false;
  }
}
