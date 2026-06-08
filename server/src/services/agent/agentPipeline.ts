import { Socket } from 'socket.io';
import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';
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
  // Dead-air uses a monotonic clock so an NTP adjustment mid-call can't fabricate
  // or erase a silence segment. callStartMs (Date.now() above) remains the wall-clock
  // anchor for human-readable transcript timestamps.
  private lastSpeakMs = performance.now();
  private potentialDeadAirStart: number | null = null;
  private monoCallStart = performance.now();

  private isShuttingDown = false;

  /** Timestamp of last interruptTTS() call. Used to prevent duplicate STT speech_started
   *  events from immediately interrupting a brand-new agent turn. */
  private lastInterruptMs = 0;

  /** Monotonic timestamp of the last agent audio chunk emitted — for diagnostics. */
  private lastAgentAudioMs = 0;

  /** Anti-self-interruption: count consecutive interims received during the current
   *  agent response. Echo bleed from imperfect browser echo cancellation typically
   *  produces 1 transient interim per leak; real user speech produces several in a row.
   *  Require N>=2 to barge in — adds ~100-300ms to interruption latency but eliminates
   *  the "Sarah cut herself off mid-sentence" failure mode. */
  private interimCountThisResponse = 0;
  private static readonly MIN_BARGE_IN_CHARS = 3;
  private static readonly MIN_INTERIMS_TO_BARGE_IN = 2;

  /** Monotonic timestamp captured the moment a user utterance flushes to Gemini.
   *  Used to log the three latency milestones: first-LLM-token, first-TTS-audio, and end-to-end. */
  private turnStartedAtMs: number | null = null;

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

        this.lastSpeakMs = performance.now();
        if (this.potentialDeadAirStart !== null) {
          this.potentialDeadAirStart = null;
        }

        if (!data.isFinal) {
          logger.info(`[AgentPipeline] STT Interim transcript: "${data.text}"`);
          this.socket.emit('transcript:interim', { text: data.text, speaker: 'customer' });

          // Anti-self-interruption barge-in. All four conditions must hold:
          //   1. Sarah is currently speaking and we're not in the opening greeting.
          //   2. The interim text is at least MIN_BARGE_IN_CHARS characters —
          //      single-character fragments are almost always echo or noise.
          //   3. We've now seen at least MIN_INTERIMS_TO_BARGE_IN interim updates
          //      during this response. Echo bleed produces single transient blips;
          //      real user speech produces a sustained stream of interims.
          const trimmed = data.text.trim();
          const longEnough = trimmed.length >= AgentPipeline.MIN_BARGE_IN_CHARS;

          if (this.isSpeaking && !this.isGreetingInProgress && longEnough) {
            this.interimCountThisResponse++;
            if (this.interimCountThisResponse >= AgentPipeline.MIN_INTERIMS_TO_BARGE_IN) {
              logger.info(`[AgentPipeline] Barge-in triggered after ${this.interimCountThisResponse} consecutive interims: "${trimmed}"`);
              this.interruptTTS();
            } else {
              logger.debug(`[AgentPipeline] Barge-in deferred — only ${this.interimCountThisResponse} interim(s) so far: "${trimmed}"`);
            }
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

          // Latency anchor: turn officially starts when we hand the utterance to the LLM.
          this.turnStartedAtMs = performance.now();
          logger.info(`[Latency] Turn started — utterance flushed to LLM`);

          this.handleCustomerInput(fullUtterance, timestamp).catch((err) => {
            logger.error('Agent pipeline error', err);
            this.socket.emit('agent:error', { message: 'Agent encountered an error' });
          });
        }, AgentPipeline.UTTERANCE_DEBOUNCE_MS);
      });



      this.stt.on('speech_started', () => {
        // We no longer cancel debounce here to avoid VAD deadlocks.
        this.lastSpeakMs = performance.now();
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

    // Anchor the interrupt counter at the start so we can detect interrupts during the retry wait.
    // interruptTTS() advances lastInterruptMs — if it moves past this anchor, the user spoke again
    // and we must abort the retry instead of speaking over them.
    const interruptAnchor = this.lastInterruptMs;

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
          // Bail out if we were shut down or the user interrupted during the wait.
          if (this.isShuttingDown || this.lastInterruptMs > interruptAnchor) {
            logger.info('[AgentPipeline] handleCustomerInput: retry skipped (shutdown or interrupt during wait)');
            break;
          }
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

    // Reset anti-self-interruption interim counter — a fresh response gets a fresh ledger.
    this.interimCountThisResponse = 0;

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
          // Latency milestone #2: first audible TTS byte ready to push to LiveKit.
          // This is the user-perceptible "agent starts speaking" moment.
          if (this.turnStartedAtMs !== null && !isGreeting) {
            const elapsedMs = Math.round(performance.now() - this.turnStartedAtMs);
            const verdict = elapsedMs < 1500 ? 'WITHIN BUDGET' : 'OVER BUDGET';
            logger.info(`[Latency] first_audio = ${elapsedMs}ms (target <1500ms) — ${verdict}`);
          }
        }
        this.recorder.addAgentAudio(chunk);
        this.livekitTransport.pushAgentAudio(chunk);
        const now = performance.now();
        this.lastSpeakMs = now;
        this.lastAgentAudioMs = now;
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

      let firstTokenLogged = false;
      for await (const chunk of stream) {
        if (abortSignal.aborted) break;
        // If the TTS WS dropped mid-stream, stop pulling Gemini tokens — they would just
        // be discarded silently. Abort the turn so the client gets a clean error rather
        // than seeing a transcript without audio.
        if (!ttsInstance.connected) {
          logger.warn(`[AgentPipeline] TTS WS disconnected mid-stream — aborting turn. speakId: ${speakId}`);
          this.currentAbortController?.abort();
          this.socket.emit('call:error', { message: 'Voice generator dropped — please try again' });
          break;
        }
        // Latency milestone #1: time-to-first-token from the LLM. Dominant cost of the budget.
        if (!firstTokenLogged && this.turnStartedAtMs !== null && !isGreeting) {
          const elapsedMs = Math.round(performance.now() - this.turnStartedAtMs);
          logger.info(`[Latency] first_token = ${elapsedMs}ms (Gemini TTFT)`);
          firstTokenLogged = true;
        }
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

      // Only flush a trailing partial if it looks like real content (has letters and >=2 chars).
      // Otherwise it's noise from a cut-off stream that would arrive as half a word.
      if (!abortSignal.aborted && ttsInstance.connected) {
        const remaining = sentenceBuffer.trim();
        if (remaining.length >= 2 && /[A-Za-z]/.test(remaining)) {
          ttsInstance.sendText(remaining + ' ');
        } else if (remaining) {
          logger.warn(`[AgentPipeline] Skipping trailing partial sentence: "${remaining}"`);
        }
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
        this.lastSpeakMs = performance.now();
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
    // Split on sentence-ending punctuation (. ! ?) followed by whitespace, OR on
    // colon/semicolon/newline — these are natural pause points Gemini emits and
    // flushing on them gets TTS started sooner without hurting prosody.
    const parts = text.split(/(?<=[.!?:;])\s+|(?<=\n)/);

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
      const now = performance.now();
      const silenceDurationMs = now - this.lastSpeakMs;
      const DEAD_AIR_THRESHOLD = 3000;

      if (silenceDurationMs > DEAD_AIR_THRESHOLD) {
        if (this.potentialDeadAirStart === null) {
          this.potentialDeadAirStart = this.lastSpeakMs;
        }
      } else if (this.potentialDeadAirStart !== null) {
        const deadAirDuration = now - this.potentialDeadAirStart;
        if (deadAirDuration > DEAD_AIR_THRESHOLD) {
          const startMs = this.potentialDeadAirStart - this.monoCallStart;
          const endMs = now - this.monoCallStart;
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
      const startMs = this.potentialDeadAirStart - this.monoCallStart;
      const endMs = performance.now() - this.monoCallStart;
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

    // Disconnect LiveKit BEFORE finalizing the recording — otherwise the room can
    // emit a few more customer frames into a half-finalized recorder, and the
    // agent's audio track stays live in the room until the async deleteRoom() call.
    try {
      this.livekitTransport.cleanup();
    } catch (err) {
      logger.warn('[AgentPipeline] LiveKit cleanup failed during stop()', err);
    }

    const audioFile = await this.recorder.finalize();

    return audioFile;
  }
}
