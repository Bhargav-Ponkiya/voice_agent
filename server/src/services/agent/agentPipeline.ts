import { Socket } from 'socket.io';
import { EventEmitter } from 'events';
import { DeepgramSTT, DeepgramTranscript } from '../stt/deepgramService';
import { DeepgramTTS } from '../tts/deepgramTtsService';

import { streamResponse, Message } from '../llm/geminiService';
import { CallRecorder } from '../recorder/callRecorder';
import { formatTimestamp } from '../../utils/audioUtils';
import { logger } from '../../utils/logger';

export interface TranscriptTurn {
  turnIndex: number;
  timestamp: string;
  speaker: 'Agent' | 'Customer';
  text: string;
  startMs: number;
  endMs?: number;
}

export class AgentPipeline extends EventEmitter {
  private socket: Socket;
  private systemPrompt: string;
  private stt: DeepgramSTT;
  private tts: DeepgramTTS | null = null;
  private recorder: CallRecorder;

  private conversationHistory: Message[] = [];
  private turns: TranscriptTurn[] = [];
  private turnIndex = 0;

  private isSpeaking = false;
  private isGreetingInProgress = false;
  private currentSpeakId = 0;
  private currentAbortController: AbortController | null = null;
  private callStartMs = Date.now();

  private deadAirCheckInterval: NodeJS.Timeout | null = null;
  private deadAirSegments: Array<{ startMs: number; endMs: number }> = [];
  private lastSpeakMs = Date.now();
  private potentialDeadAirStart: number | null = null;

  private isShuttingDown = false;

  /** Timestamp of last interruptTTS() call. Used to prevent duplicate STT speech_started
   *  events from immediately interrupting a brand-new agent turn. */
  private lastInterruptMs = 0;

  /**
   * Utterance accumulation buffer.
   * Deepgram's endpointing fires transcript:final on every pause — even mid-sentence.
   * We accumulate all final fragments and only send to Gemini after a period of silence.
   * This is the industry-standard "barge-in with accumulation" pattern (used by Alexa, Duplex).
   */
  private utteranceBuffer = '';
  private utteranceDebounceTimer: NodeJS.Timeout | null = null;
  private static readonly UTTERANCE_DEBOUNCE_MS = 800;

  private callId: string;
  private roomName: string;
  private livekitTransport: import('../livekit/LiveKitTransport').LiveKitTransport;

  constructor(socket: Socket, callId: string, systemPrompt: string, roomName: string) {
    super();
    this.socket = socket;
    this.callId = callId;
    this.roomName = roomName;
    this.systemPrompt = systemPrompt;
    this.stt = new DeepgramSTT();
    this.recorder = new CallRecorder(callId);
    
    // Dynamic import to avoid circular dependencies if any
    const { LiveKitTransport } = require('../livekit/LiveKitTransport');
    this.livekitTransport = new LiveKitTransport(this);
  }

  async start(): Promise<void> {
    try {
      logger.info(`[AgentPipeline] Starting pipeline for room ${this.roomName}...`);
      await this.livekitTransport.connect(this.roomName);

      logger.info('[AgentPipeline] Connecting STT...');
      this.stt.connect();

      this.tts = new DeepgramTTS();
      logger.info('[AgentPipeline] Connecting persistent Deepgram TTS...');
      await this.tts.connect();

      this.stt.on('transcript', (data: DeepgramTranscript) => {
        if (!data.text.trim()) return;

        this.lastSpeakMs = Date.now();
        if (this.potentialDeadAirStart !== null) {
          this.potentialDeadAirStart = null;
        }

        if (!data.isFinal) {
          logger.info(`[AgentPipeline] STT Interim transcript: "${data.text}"`);
          this.socket.emit('transcript:interim', { text: data.text, speaker: 'customer' });

          // Robust Barge-In: Interrupt the agent ONLY when STT produces an actual transcribed word.
          // This makes barge-in completely immune to echo clicks or chair squeaks that trigger VAD falsely.
          if (this.isSpeaking && !this.isGreetingInProgress && data.text.trim().length > 0) {
            logger.info(`[AgentPipeline] Barge-in triggered by interim transcript: "${data.text}"`);
            this.interruptTTS();
          }

          // Reset utterance debounce on every interim — it proves user is still speaking.
          if (this.utteranceDebounceTimer) {
            clearTimeout(this.utteranceDebounceTimer);
            this.utteranceDebounceTimer = null;
            logger.info('[AgentPipeline] Utterance debounce reset by interim transcript (user still speaking)');
          }
          return;
        }

        logger.info(`[AgentPipeline] STT Final transcript: "${data.text}"`);

        // ── Utterance Accumulation Buffer ──────────────────────────────────────
        // Deepgram's endpointing fires transcript:final on every natural pause,
        // even in the middle of a sentence (e.g., "I was charged" / "twice in one month").
        // Without accumulation, we'd send the first fragment to Gemini and lose context.
        //
        // Strategy: buffer every final fragment and restart a silence timer.
        // Only when UTTERANCE_DEBOUNCE_MS of silence passes do we flush the buffer
        // and call Gemini with the FULL accumulated utterance.
        // ──────────────────────────────────────────────────────────────────────
        const separator = this.utteranceBuffer ? ' ' : '';
        this.utteranceBuffer += separator + data.text.trim();
        logger.info(`[AgentPipeline] Utterance buffer updated: "${this.utteranceBuffer}"`);

        // Show the accumulated text as the confirmed customer turn immediately in the UI
        const timestampMs = Date.now() - this.callStartMs;
        const timestamp = formatTimestamp(timestampMs);
        const currentCustomerTurnIndex = this.turnIndex + 1;
        this.socket.emit('transcript:final', {
          text: this.utteranceBuffer,
          timestamp,
          speaker: 'customer',
          turnIndex: currentCustomerTurnIndex,
        });

        // Debounce: cancel any running timer and restart it
        if (this.utteranceDebounceTimer) {
          clearTimeout(this.utteranceDebounceTimer);
          this.utteranceDebounceTimer = null;
        }

        const accumulatedText = this.utteranceBuffer;
        this.utteranceDebounceTimer = setTimeout(() => {
          this.utteranceDebounceTimer = null;
          const fullUtterance = this.utteranceBuffer.trim();
          this.utteranceBuffer = '';

          if (!fullUtterance) return;
          logger.info(`[AgentPipeline] Utterance debounce fired. Sending to Gemini: "${fullUtterance}"`);

          // Record the finalized customer turn
          this.turns.push({
            turnIndex: ++this.turnIndex,
            timestamp,
            speaker: 'Customer',
            text: fullUtterance,
            startMs: timestampMs,
          });

          this.handleCustomerInput(fullUtterance, timestamp).catch((err) => {
            logger.error('Agent pipeline error', err);
            this.socket.emit('agent:error', { message: 'Agent encountered an error' });
          });
        }, AgentPipeline.UTTERANCE_DEBOUNCE_MS);
      });



      this.stt.on('speech_started', () => {
        // We no longer cancel debounce here to avoid VAD deadlocks.
        this.lastSpeakMs = Date.now();
      });

      this.stt.on('error', (err) => {
        logger.error('STT error in pipeline', err);
        this.socket.emit('stt:error', { message: 'Speech recognition error — please try again' });
      });

      this.startDeadAirDetection();

      // Wait 1000ms before greeting to allow WebRTC negotiation and ICE connection to settle on the client.
      // This prevents the initial greeting audio from being clipped or sounding choppy on start.
      logger.info('[AgentPipeline] Waiting 1000ms for WebRTC connection to stabilize...');
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      if (this.isShuttingDown) return;

      // Send the initial agent greeting
      await this.sendAgentGreeting();
    } catch (err) {
      logger.error('[AgentPipeline] Error during start, calling stop() to cleanup...', err);
      await this.stop();
      throw err;
    }
  }

  private async sendAgentGreeting(): Promise<void> {
    this.isGreetingInProgress = true;
    const greetingPrompt = 'Start the call now with your greeting.';
    this.conversationHistory.push({ role: 'user', content: greetingPrompt });
    try {
      await this.streamAgentResponse(greetingPrompt, true);
    } finally {
      this.isGreetingInProgress = false;
    }
  }

  receiveAudio(chunk: Buffer): void {
    if (this.isShuttingDown) return;
    this.stt.sendAudio(chunk);
    this.recorder.addCustomerAudio(chunk);
  }

  private async handleCustomerInput(text: string, _timestamp: string): Promise<void> {
    if (this.isSpeaking) {
      this.interruptTTS();
    }

    this.socket.emit('agent:thinking');

    let retryCount = 0;
    const MAX_RETRIES = 1;
    const RETRY_DELAY_MS = 2500;

    while (retryCount <= MAX_RETRIES) {
      try {
        await this.streamAgentResponse(text, false);
        return; // success
      } catch (err: unknown) {
        const errStr = err instanceof Error ? err.message : '';
        const isRetryable = errStr.includes('503') || errStr.includes('UNAVAILABLE') || errStr.includes('high demand') ||
                            errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED');

        if (isRetryable && retryCount < MAX_RETRIES) {
          retryCount++;
          logger.warn(`[AgentPipeline] handleCustomerInput: Gemini transient error (${errStr.slice(0, 60)}). Retrying in ${RETRY_DELAY_MS}ms (attempt ${retryCount}/${MAX_RETRIES})...`);
          this.socket.emit('agent:retry', { message: 'Momentary delay — retrying...', attempt: retryCount });
          await new Promise<void>((r) => setTimeout(r, RETRY_DELAY_MS));
          // Check if we were shut down or interrupted during the wait
          if (this.isShuttingDown || this.currentSpeakId > (this.currentSpeakId)) break;
        } else {
          throw err; // surface to outer error handler
        }
      }
    }
  }

  private async streamAgentResponse(
    userText: string,
    isGreeting: boolean
  ): Promise<void> {
    const speakId = ++this.currentSpeakId;
    logger.info(`[AgentPipeline] streamAgentResponse called. userText: "${userText}", isGreeting: ${isGreeting}, speakId: ${speakId}`);
    if (!isGreeting) {
      this.conversationHistory.push({ role: 'user', content: userText });
    }

    this.currentAbortController = new AbortController();
    const abortSignal = this.currentAbortController.signal;

    // Tiny yield to let any synchronous abort (e.g., a rapid speech_started re-fire)
    // settle before we touch the network. If we're already aborted, bail out now.
    await new Promise<void>((r) => setImmediate(r));
    if (abortSignal.aborted) {
      logger.warn(`[AgentPipeline] streamAgentResponse aborted immediately before Gemini call. speakId: ${speakId} — skipping turn.`);
      return;
    }

    let fullResponse = '';
    let sentenceBuffer = '';
    const ttsStartMs = Date.now() - this.callStartMs;

    this.isSpeaking = true;
    this.socket.emit('agent:speaking');

    const ttsInstance = this.tts;
    if (!ttsInstance || !ttsInstance.connected) {
      logger.error('[AgentPipeline] Persistent TTS is not connected');
      this.socket.emit('call:error', { message: 'Voice generator is not connected' });
      this.isSpeaking = false;
      return;
    }

    const listeners: Array<{ event: string; fn: any }> = [];
    const addTtsListener = (event: string, fn: any) => {
      ttsInstance.on(event, fn);
      listeners.push({ event, fn });
    };

    const cleanupTtsListeners = () => {
      for (const l of listeners) {
        ttsInstance.off(l.event, l.fn);
      }
    };

    let audioChunksCount = 0;
    let playbackTimeoutId: NodeJS.Timeout | null = null;

    try {
      addTtsListener('audio', (chunk: Buffer) => {
        if (abortSignal.aborted) {
          logger.info(`[AgentPipeline] Deepgram audio chunk ignored (aborted). speakId: ${speakId}`);
          return;
        }
        audioChunksCount++;
        if (audioChunksCount === 1) {
          logger.info(`[AgentPipeline] Deepgram first audio chunk received: ${chunk.length} bytes`);
        }
        this.recorder.addAgentAudio(chunk);
        this.livekitTransport.pushAgentAudio(chunk);
        this.lastSpeakMs = Date.now();
      });

      addTtsListener('error', (err: Error) => {
        logger.error('[AgentPipeline] Deepgram TTS error inside streamAgentResponse:', err);
        let clientMessage = 'Voice generation failed (Deepgram)';
        const errStr = err.message || '';
        if (errStr.includes('invalid_api_key') || errStr.includes('api key') || errStr.includes('unauthorized') || errStr.includes('401')) {
          clientMessage = 'Deepgram TTS: Invalid API Key. Please verify your Deepgram credentials.';
        } else if (errStr) {
          clientMessage = `Deepgram TTS: ${errStr}`;
        }
        this.socket.emit('call:error', { message: clientMessage });
      });

      const playbackPromise = new Promise<void>((resolve) => {
        let finished = false;

        const cleanup = () => {
          if (!finished) {
            finished = true;
            if (playbackTimeoutId) {
              clearTimeout(playbackTimeoutId);
              playbackTimeoutId = null;
            }
            resolve();
          }
        };

        addTtsListener('flushed', () => {
          logger.info(`[AgentPipeline] Deepgram audio stream finished (flushed). speakId: ${speakId}`);
          cleanup();
        });
        addTtsListener('error', cleanup);
        addTtsListener('close', () => {
          logger.warn(`[AgentPipeline] Deepgram connection closed during playback. speakId: ${speakId}`);
          cleanup();
        });

        if (abortSignal) {
          if (abortSignal.aborted) {
            cleanup();
          } else {
            abortSignal.addEventListener('abort', cleanup);
          }
        }

        // Safety timeout to prevent hanging if Deepgram doesn't respond or flush (15 seconds)
        playbackTimeoutId = setTimeout(() => {
          logger.warn(`[AgentPipeline] Safety timeout (15s) triggered waiting for Deepgram flush. speakId: ${speakId}`);
          cleanup();
        }, 15000);
      });

      logger.info('[AgentPipeline] Requesting Gemini stream...');
      const stream = streamResponse(this.systemPrompt, this.conversationHistory, abortSignal);

      for await (const chunk of stream) {
        if (abortSignal.aborted) break;
        fullResponse += chunk;
        sentenceBuffer += chunk;

        // Stream each Gemini text chunk to the client immediately so the transcript
        // panel shows the agent's words in real-time as they are generated.
        this.socket.emit('transcript:agent_stream', { chunk, speakId });

        const { sentences, remaining } = this.extractSentences(sentenceBuffer);
        sentenceBuffer = remaining;

        for (const sentence of sentences) {
          if (abortSignal.aborted) break;
          const cleaned = sentence.trim();
          if (cleaned) {
            ttsInstance.sendText(cleaned + ' ');
          }
        }
      }

      if (!abortSignal.aborted && sentenceBuffer.trim()) {
        const remaining = sentenceBuffer.trim();
        ttsInstance.sendText(remaining + ' ');
      }

      if (!abortSignal.aborted && ttsInstance.connected) {
        ttsInstance.flush();
        logger.info('[AgentPipeline] Waiting for Deepgram audio stream to finish...');
        await playbackPromise;
        logger.info('[AgentPipeline] Deepgram audio stream finished or timed out');
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        logger.error('Agent stream error', err);
        // Only emit agent:error if we couldn't get any response text from Gemini
        if (!fullResponse.trim()) {
          let msg = 'Agent response error — please speak again';
          const errStr = err.message || '';
          if (errStr.includes('503') || errStr.includes('UNAVAILABLE') || errStr.includes('high demand')) {
            msg = 'Gemini is temporarily unavailable. Please speak again in a moment.';
          } else if (errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED')) {
            msg = 'Gemini rate limit exceeded. Please speak again shortly.';
          } else if (errStr.includes('API key') || errStr.includes('API_KEY_INVALID') || errStr.includes('400')) {
            msg = 'Gemini LLM: Invalid API Key. Please verify your credentials.';
          }
          this.socket.emit('agent:error', { message: msg });
        }
        throw err; // rethrow so handleCustomerInput retry logic can catch it
      }
    } finally {
      cleanupTtsListeners();
      if (playbackTimeoutId) {
        clearTimeout(playbackTimeoutId);
        playbackTimeoutId = null;
      }
      // CRITICAL: Always reset isSpeaking in finally so it runs even when an exception
      // (e.g., Gemini 503) causes the function to exit early via throw.
      // Previously this only ran at the bottom of the function, leaving the pipeline
      // stuck in isSpeaking=true state after any non-AbortError exception.
      if (this.currentSpeakId === speakId) {
        this.isSpeaking = false;
        this.lastSpeakMs = Date.now();
      }
      // Clear any partial streaming transcript on the client if this speak is ending
      if (this.currentSpeakId === speakId) {
        this.socket.emit('transcript:agent_stream_end', { speakId });
      }
    }

    const wasInterrupted = abortSignal.aborted;
    if (fullResponse.trim()) {
      const agentTimestamp = formatTimestamp(ttsStartMs);
      const textToSave = fullResponse.trim() + (wasInterrupted ? ' [interrupted]' : '');
      this.conversationHistory.push({ role: 'assistant', content: textToSave });

      this.turns.push({
        turnIndex: ++this.turnIndex,
        timestamp: agentTimestamp,
        speaker: 'Agent',
        text: textToSave,
        startMs: ttsStartMs,
        endMs: Date.now() - this.callStartMs,
      });

      this.socket.emit('agent:response', { text: textToSave, timestamp: agentTimestamp });
    } else if (!wasInterrupted) {
      logger.warn(`[AgentPipeline] streamAgentResponse finished but yielded no text. speakId: ${speakId}`);
      this.socket.emit('agent:error', { message: 'Agent response failed. Please try speaking again.' });
    }

    // isSpeaking is now reset in the finally block above
  }

  private interruptTTS(): void {
    this.lastInterruptMs = Date.now();
    this.currentSpeakId++; // Invalidate any pending speaks from checking this.isSpeaking later
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    if (this.tts) {
      this.tts.clear();
      this.livekitTransport.clearAgentAudioQueue();
    }
    this.isSpeaking = false;
    this.socket.emit('tts:interrupted');
  }

  private extractSentences(text: string): { sentences: string[]; remaining: string } {
    const sentences: string[] = [];
    // Split on sentence-ending punctuation followed by space or end
    const parts = text.split(/(?<=[.!?])\s+/);

    if (parts.length <= 1) {
      return { sentences: [], remaining: text };
    }

    // All complete parts except the last (which may be incomplete)
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i].trim()) sentences.push(parts[i]);
    }

    return { sentences, remaining: parts[parts.length - 1] };
  }

  private startDeadAirDetection(): void {
    this.deadAirCheckInterval = setInterval(() => {
      const silenceDurationMs = Date.now() - this.lastSpeakMs;
      const DEAD_AIR_THRESHOLD = 3000;

      if (silenceDurationMs > DEAD_AIR_THRESHOLD) {
        if (this.potentialDeadAirStart === null) {
          this.potentialDeadAirStart = this.lastSpeakMs;
        }
      } else if (this.potentialDeadAirStart !== null) {
        const deadAirDuration = Date.now() - this.potentialDeadAirStart;
        if (deadAirDuration > DEAD_AIR_THRESHOLD) {
          const startMs = this.potentialDeadAirStart - this.callStartMs;
          const endMs = Date.now() - this.callStartMs;
          this.deadAirSegments.push({ startMs, endMs });
          this.socket.emit('dead_air_detected', {
            timestamp: formatTimestamp(startMs),
            durationMs: deadAirDuration,
          });
        }
        this.potentialDeadAirStart = null;
      }
    }, 1000);
  }

  getTurns(): TranscriptTurn[] {
    return this.turns;
  }

  getDeadAirSegments() {
    return this.deadAirSegments.map((seg) => ({
      startMs: seg.startMs,
      endMs: seg.endMs,
      durationMs: seg.endMs - seg.startMs,
      timestamp: formatTimestamp(seg.startMs),
    }));
  }

  async stop(): Promise<string | null> {
    this.isShuttingDown = true;

    if (this.deadAirCheckInterval) {
      clearInterval(this.deadAirCheckInterval);
      this.deadAirCheckInterval = null;
    }

    // Finalize any pending dead air segment that was in progress when call ended
    if (this.potentialDeadAirStart !== null) {
      const startMs = this.potentialDeadAirStart - this.callStartMs;
      const endMs = Date.now() - this.callStartMs;
      if (endMs - startMs > 3000) {
        this.deadAirSegments.push({ startMs, endMs });
      }
      this.potentialDeadAirStart = null;
    }

    // Cancel any pending utterance debounce to prevent firing after shutdown
    if (this.utteranceDebounceTimer) {
      clearTimeout(this.utteranceDebounceTimer);
      this.utteranceDebounceTimer = null;
    }
    this.utteranceBuffer = '';

    this.interruptTTS();
    if (this.tts) {
      this.tts.close();
      this.tts = null;
    }
    this.stt.close();

    const audioFile = await this.recorder.finalize();

    return audioFile;
  }
}
