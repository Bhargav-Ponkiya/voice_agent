import React, { useEffect, useRef, useState, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { Phone, PhoneOff, Mic, MicOff, Sparkles, Radio, AlertTriangle, X } from 'lucide-react';
import { CallStatus, LiveTurn, Scorecard } from '../../types';
import { startCall, isApiError } from '../../services/api';
import { LiveKitRoom, RoomAudioRenderer, useLocalParticipant } from '@livekit/components-react';
import '@livekit/components-styles';
import LiveTranscript from './LiveTranscript';
import ErrorBanner from '../shared/ErrorBanner';

function MicToggle({ isMuted, onToggle, isUserSpeaking }: { isMuted: boolean, onToggle: () => void, isUserSpeaking: boolean }) {
  const { localParticipant } = useLocalParticipant();
  
  useEffect(() => {
    if (localParticipant) {
      localParticipant.setMicrophoneEnabled(!isMuted).catch(console.error);
    }
  }, [isMuted, localParticipant]);

  return (
    <button
      onClick={onToggle}
      aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
      aria-pressed={isMuted}
      className={`w-12 h-12 rounded-full flex items-center justify-center transition-all border cursor-pointer relative ${
        isMuted
          ? 'bg-amber-50 border-amber-200 text-amber-600 hover:bg-amber-100/70'
          : isUserSpeaking
          ? 'bg-emerald-500 border-emerald-600 text-white shadow-lg shadow-emerald-500/35 scale-110'
          : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
      }`}
    >
      {isUserSpeaking && (
        <span className="absolute inset-0 rounded-full bg-emerald-500/30 animate-ping pointer-events-none" />
      )}
      {isMuted ? <MicOff className="w-5 h-5 z-10" aria-hidden="true" /> : <Mic className="w-5 h-5 z-10" aria-hidden="true" />}
    </button>
  );
}

interface Props {
  onCallComplete: (callId: string, scorecard: Scorecard) => void;
}

export default function VoiceCallInterface({ onCallComplete }: Props) {
  const [status, setStatus] = useState<CallStatus>('idle');
  const [callId, setCallId] = useState<string | null>(null);
  const [promptVersion, setPromptVersion] = useState(1);
  const [turns, setTurns] = useState<LiveTurn[]>([]);
  const [interimText, setInterimText] = useState('');
  const [streamingAgentText, setStreamingAgentText] = useState('');
  const [callDuration, setCallDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [agentStatus, setAgentStatus] = useState<'idle' | 'thinking' | 'speaking'>('idle');
  
  const [livekitToken, setLivekitToken] = useState<string | null>(null);
  const [livekitUrl, setLivekitUrl] = useState<string | null>(null);

  /** Tracks the speakId of the current streaming response so we can clear on interrupt */
  const streamingSpeakIdRef = useRef<number | null>(null);

  /** rAF-based throttle for streaming text. Gemini emits 10-30 chunks per response;
   *  without throttling, each chunk re-renders the whole call interface (including the
   *  LiveKitRoom subtree), causing visible re-render judder during Sarah's speech. */
  const streamingBufferRef = useRef('');
  const streamingFlushScheduledRef = useRef(false);

  const socketRef = useRef<Socket | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const turnIdRef = useRef(0);
  const analysisTimerRef = useRef<NodeJS.Timeout | null>(null);

  const isCallActive = status === 'active' || status === 'agent_thinking' || status === 'agent_speaking';
  const isUserSpeaking = interimText.length > 0;

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const addTurn = useCallback((speaker: 'Agent' | 'Customer', text: string, timestamp: string) => {
    const id = String(++turnIdRef.current);
    setTurns((prev) => [...prev.filter((t) => !t.isInterim), { id, speaker, text, timestamp }]);
    setInterimText('');
  }, []);

  const handleStartCall = async () => {
    if (socketRef.current) {
      try {
        // Detach listeners BEFORE disconnecting so the old socket's async 'disconnect'
        // event can't mutate state for the new socket (e.g., flipping us to 'error').
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
      } catch (e) { /* ignore */ }
      socketRef.current = null;
    }

    setError(null);
    setWarning(null);
    setStatus('connecting');
    setTurns([]);
    setCallDuration(0);
    setLivekitToken(null);
    setLivekitUrl(null);

    try {
      const data = await startCall();
      setCallId(data.callId);
      setPromptVersion(data.promptVersion);
      setLivekitToken(data.userToken);
      setLivekitUrl(data.livekitUrl);
      console.log(`[VoiceCall] startCall API resolved. CallId: ${data.callId}`);

      const socketUrl = import.meta.env.VITE_API_URL || '/';
      console.log(`[VoiceCall] Connecting socket to: ${socketUrl}`);
      const socket = io(socketUrl, { transports: ['websocket'] });
      socketRef.current = socket;

      socket.on('connect', () => {
        console.log('[VoiceCall] Socket connected! Emitting call:start...');
        socket.emit('call:start', { callId: data.callId });
      });

      socket.on('call:started', () => {
        console.log('[VoiceCall] call:started received from server');
        setStatus('active');
        timerRef.current = setInterval(() => setCallDuration((d) => d + 1), 1000);
      });

      socket.on('transcript:interim', ({ text }: { text: string }) => {
        console.log(`[VoiceCall] transcript:interim: "${text}"`);
        setInterimText(text);
      });

      socket.on('transcript:final', ({ text, timestamp, turnIndex }: { text: string; timestamp: string; turnIndex: number }) => {
        console.log(`[VoiceCall] transcript:final: "${text}" at ${timestamp} (turnIndex: ${turnIndex})`);
        setInterimText('');
        // The server uses utterance accumulation — it may emit multiple transcript:final
        // events for the same utterance as fragments arrive. We replace the last Customer
        // turn if it exists and has the same turnIndex, rather than duplicating it.
        setTurns((prev) => {
          const lastTurn = prev[prev.length - 1];
          if (lastTurn && lastTurn.speaker === 'Customer' && lastTurn.turnIndex === turnIndex) {
            // Replace the last customer turn with the accumulated text
            return [...prev.slice(0, -1), { ...lastTurn, text, timestamp }];
          }
          // First fragment — add a fresh turn
          const id = String(++turnIdRef.current);
          return [...prev, { id, speaker: 'Customer', text, timestamp, turnIndex }];
        });
      });

      socket.on('agent:thinking', () => {
        console.log('[VoiceCall] agent:thinking received');
        setStatus('agent_thinking');
        setAgentStatus('thinking');
        // Clear any stale streaming text when a new thinking phase begins
        streamingBufferRef.current = '';
        setStreamingAgentText('');
        streamingSpeakIdRef.current = null;
      });

      socket.on('agent:speaking', () => {
        console.log('[VoiceCall] agent:speaking received');
        setStatus('agent_speaking');
        setAgentStatus('speaking');
      });

      // Real-time word-by-word transcript from Gemini as it streams.
      // We accumulate into a ref and flush to React state at most once per animation frame.
      socket.on('transcript:agent_stream', ({ chunk, speakId }: { chunk: string; speakId: number }) => {
        if (streamingSpeakIdRef.current !== speakId) {
          streamingSpeakIdRef.current = speakId;
          streamingBufferRef.current = chunk;
        } else {
          streamingBufferRef.current += chunk;
        }
        if (!streamingFlushScheduledRef.current) {
          streamingFlushScheduledRef.current = true;
          requestAnimationFrame(() => {
            streamingFlushScheduledRef.current = false;
            if (streamingSpeakIdRef.current === speakId) {
              setStreamingAgentText(streamingBufferRef.current);
            }
          });
        }
      });

      socket.on('transcript:agent_stream_end', ({ speakId }: { speakId: number }) => {
        if (streamingSpeakIdRef.current === speakId) {
          streamingBufferRef.current = '';
          setStreamingAgentText('');
          streamingSpeakIdRef.current = null;
        }
      });

      socket.on('agent:retry', ({ message }: { message: string }) => {
        console.log(`[VoiceCall] agent:retry: "${message}"`);
        setWarning(message);
        // Clear warning after 3 seconds
        setTimeout(() => setWarning(null), 3000);
      });

      socket.on('agent:error', ({ message }: { message: string }) => {
        console.log(`[VoiceCall] agent:error: "${message}"`);
        setWarning(message);
        setStatus((prev) => (prev === 'ending' || prev === 'analyzing' || prev === 'complete' ? prev : 'active'));
        setAgentStatus('idle');
      });

      socket.on('agent:response', ({ text, timestamp }: { text: string; timestamp: string }) => {
        console.log(`[VoiceCall] agent:response: "${text}" at ${timestamp}`);
        // Finalize: commit the full response as a confirmed turn and clear streaming
        streamingBufferRef.current = '';
        setStreamingAgentText('');
        streamingSpeakIdRef.current = null;
        addTurn('Agent', text, timestamp);
        setStatus((prev) => (prev === 'ending' || prev === 'analyzing' || prev === 'complete' ? prev : 'active'));
        setAgentStatus('idle');
      });

      socket.on('tts:interrupted', () => {
        // Clear streaming text immediately on interrupt so the partial transcript disappears
        streamingBufferRef.current = '';
        setStreamingAgentText('');
        streamingSpeakIdRef.current = null;
        setStatus((prev) => (prev === 'ending' || prev === 'analyzing' || prev === 'complete' ? prev : 'active'));
        setAgentStatus('idle');
      });

      socket.on('call:ended', ({ duration }: { duration: number }) => {
        setStatus('analyzing');
        if (timerRef.current) clearInterval(timerRef.current);
        setCallDuration(duration);
      });

      socket.on('analysis:started', () => {
        setStatus('analyzing');
        // Safety net: if analysis:complete never fires (server crash), timeout after 60s
        if (analysisTimerRef.current) clearTimeout(analysisTimerRef.current);
        analysisTimerRef.current = setTimeout(() => {
          setError('Analysis timed out — please refresh and check the dashboard');
          setStatus('error');
          socket.disconnect();
        }, 60_000);
      });

      socket.on('analysis:complete', ({ callId: cid, scorecard }: { callId: string; scorecard: Scorecard }) => {
        if (analysisTimerRef.current) {
          clearTimeout(analysisTimerRef.current);
          analysisTimerRef.current = null;
        }
        setStatus('complete');
        onCallComplete(cid, scorecard);
        socket.disconnect();
      });

      socket.on('analysis:error', ({ message }: { message: string }) => {
        if (analysisTimerRef.current) {
          clearTimeout(analysisTimerRef.current);
          analysisTimerRef.current = null;
        }
        setError(message || 'Analysis failed');
        setStatus('error');
      });

      socket.on('prompt:evolved', ({ version, summary }: { version: number; summary: string }) => {
        console.log(`Prompt evolved to v${version}: ${summary}`);
      });

      socket.on('call:error', ({ message }: { message: string }) => {
        setError(message);
        setStatus('error');
        socket.disconnect();
      });

      socket.on('tts:budget_cap', ({ reason }: { reason: string }) => {
        setWarning(reason);
      });

      // Use a ref flag instead of the stale `status` closure to detect active calls
      socket.on('disconnect', (reason: string) => {
        // Any unexpected disconnect while socket is still registered is a connection loss
        if (reason !== 'io client disconnect') {
          setError('Connection lost — please check your network and try again');
          setStatus('error');
          if (analysisTimerRef.current) {
            clearTimeout(analysisTimerRef.current);
            analysisTimerRef.current = null;
          }
        }
      });
    } catch (err: unknown) {
      let msg = 'Failed to start call — please try again.';
      if (isApiError(err)) {
        msg = err.message;
      } else if (err instanceof Error) {
        msg = err.message;
      }
      setError(msg);
      setStatus('error');
    }
  };

  const handleEndCall = useCallback(() => {
    if (!socketRef.current) return;
    setStatus('ending');
    socketRef.current.emit('call:end');
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (analysisTimerRef.current) clearTimeout(analysisTimerRef.current);
      if (socketRef.current) {
        socketRef.current.removeAllListeners();
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
  }, []);

  const statusConfig: Record<CallStatus, { badge: string; label: string; dot: string }> = {
    idle: { badge: 'bg-slate-50 border-slate-200 text-slate-600', label: 'Ready', dot: 'bg-slate-400' },
    connecting: { badge: 'bg-amber-50 border-amber-200 text-amber-700', label: 'Connecting…', dot: 'bg-amber-500' },
    active: { badge: 'bg-emerald-50 border-emerald-200 text-emerald-700', label: 'Live', dot: 'bg-emerald-500 soft-pulse text-emerald-500' },
    agent_thinking: { badge: 'bg-ai-50 border-ai-200 text-ai-700', label: 'Thinking', dot: 'bg-ai-500 soft-pulse text-ai-500' },
    agent_speaking: { badge: 'bg-brand-50 border-brand-200 text-brand-700', label: 'Speaking', dot: 'bg-brand-500 soft-pulse text-brand-500' },
    ending: { badge: 'bg-orange-50 border-orange-200 text-orange-700', label: 'Ending…', dot: 'bg-orange-500' },
    analyzing: { badge: 'bg-brand-50 border-brand-200 text-brand-700', label: 'Analyzing…', dot: 'bg-brand-500 soft-pulse text-brand-500' },
    complete: { badge: 'bg-emerald-50 border-emerald-200 text-emerald-700', label: 'Complete', dot: 'bg-emerald-500' },
    error: { badge: 'bg-red-50 border-red-200 text-red-700', label: 'Error', dot: 'bg-red-500' },
  };

  const cfg = statusConfig[status];

  const innerContent = (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch w-full min-h-0">
      {/* Left Column: Status, Orb, Controls */}
      <div className="lg:col-span-5 flex flex-col gap-5 h-full min-h-0">
        {/* Status pill */}
        <div className="glass rounded-2xl px-5 py-3.5 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold border ${cfg.badge}`}>
              <span className={`w-1.5 h-1.5 rounded-full ${cfg.dot}`} />
              {cfg.label}
            </span>
            {isCallActive && (
              <span className="text-slate-500 font-mono text-sm tabular-nums ml-1">
                {formatDuration(callDuration)}
              </span>
            )}
          </div>

          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-brand-500" />
              Prompt v{promptVersion}
            </span>
            {callId && (
              <span className="font-mono opacity-60 hidden sm:inline">
                #{callId.slice(0, 8)}
              </span>
            )}
          </div>
        </div>

        {error && (
          <ErrorBanner
            message={error}
            onDismiss={() => setError(null)}
            onRetry={status === 'error' ? handleStartCall : undefined}
            className="flex-shrink-0"
          />
        )}

        {warning && (
          <div
            role="status"
            className="flex items-start gap-3 px-4 py-3.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-sm shadow-sm flex-shrink-0"
            style={{ animation: 'toast-enter 0.35s ease-out' }}
          >
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" aria-hidden="true" />
            <p className="flex-1 leading-relaxed font-medium">{warning}</p>
            <button
              onClick={() => setWarning(null)}
              className="p-1 rounded-lg hover:bg-amber-100 text-amber-400 hover:text-amber-600 transition-colors cursor-pointer flex items-center justify-center"
              aria-label="Dismiss warning"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Agent avatar / waveform card */}
        {(isCallActive || status === 'connecting' || status === 'analyzing') && (
          <div className="glass rounded-3xl p-8 flex-1 flex flex-col items-center justify-center gap-6 min-h-[280px]">
            <div className="relative">
              {/* Outer aura */}
              <div className={`absolute inset-0 rounded-full blur-2xl transition-all duration-500 ${
                agentStatus === 'speaking' ? 'bg-brand-500/25 scale-150' :
                agentStatus === 'thinking' ? 'bg-ai-500/20 scale-125' :
                'bg-brand-500/5 scale-100'
              }`} />

              {/* Inner orb */}
              <div className={`relative w-24 h-24 rounded-full flex items-center justify-center transition-all duration-300 ${
                agentStatus === 'speaking'
                  ? 'bg-gradient-to-br from-brand-400 to-brand-600 shadow-lg shadow-brand-500/35'
                  : agentStatus === 'thinking'
                  ? 'bg-gradient-to-br from-ai-400 to-ai-600 shadow-lg shadow-ai-500/30'
                  : 'bg-gradient-to-br from-slate-100 to-slate-200 border border-slate-300/80 shadow-inner'
              }`}>
                {agentStatus === 'speaking' ? (
                  <div className="flex items-end gap-1.5 h-9">
                    {[...Array(5)].map((_, i) => (
                      <div
                        key={i}
                        className="waveform-bar w-1.5 bg-white rounded-full h-full"
                        style={{ animationDelay: `${i * 0.1}s` }}
                      />
                    ))}
                  </div>
                ) : agentStatus === 'thinking' ? (
                  <div className="flex gap-1.5 animate-pulse">
                    {[...Array(3)].map((_, i) => (
                      <div
                        key={i}
                        className="float-particle w-2.5 h-2.5 bg-white/95 rounded-full"
                        style={{ animationDelay: `${i * 0.15}s` }}
                      />
                    ))}
                  </div>
                ) : (
                  <Radio className="w-9 h-9 text-slate-400" />
                )}
              </div>
            </div>

            <div className="text-center">
              <p className="text-base font-semibold tracking-tight text-slate-800">
                {agentStatus === 'speaking' ? 'Sarah is speaking' :
                 agentStatus === 'thinking' ? 'Sarah is thinking…' :
                 status === 'analyzing' ? 'Running AI analysis' :
                 'Listening'}
              </p>
              <p className="text-xs text-slate-500 mt-1.5">
                {status === 'analyzing' ? 'Scoring + evolving the prompt' : 'NovaTel · Billing Support'}
              </p>
            </div>
          </div>
        )}

        {/* Idle state */}
        {status === 'idle' && (
          <div className="glass rounded-3xl p-8 flex-1 flex flex-col items-center justify-center gap-5 fade-up min-h-[280px]">
            <div className="relative">
              <div className="absolute inset-0 rounded-full bg-brand-500/15 blur-2xl" />
              <div className="relative w-24 h-24 rounded-full bg-gradient-to-br from-brand-500 to-brand-600 flex items-center justify-center glow-brand">
                <Phone className="w-9 h-9 text-white" />
              </div>
            </div>
            <div className="text-center max-w-sm">
              <h3 className="text-lg font-semibold tracking-tight text-slate-800">Meet Sarah</h3>
              <p className="text-sm text-slate-500 mt-2 leading-relaxed">
                Your AI billing support agent. Speak naturally — interrupt anytime. Calls are analyzed and the agent self-improves after every conversation.
              </p>
            </div>
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center justify-center gap-4 flex-shrink-0">
          {status === 'idle' || status === 'error' ? (
            <button
              onClick={handleStartCall}
              aria-label="Start voice call"
              className="btn-shine relative group flex items-center gap-3 bg-gradient-to-br from-emerald-500 to-emerald-600 hover:from-emerald-400 hover:to-emerald-500 text-white px-9 py-3.5 rounded-full font-semibold text-base transition-all shadow-md hover:shadow-lg active:scale-95 cursor-pointer"
            >
              <Phone className="w-5 h-5" aria-hidden="true" />
              Start Call
            </button>
          ) : isCallActive ? (
            <>
              <MicToggle 
                isMuted={isMuted} 
                onToggle={() => setIsMuted((m) => !m)} 
                isUserSpeaking={isUserSpeaking} 
              />
              <button
                onClick={handleEndCall}
                aria-label="End voice call"
                className="btn-shine relative group flex items-center gap-3 bg-gradient-to-br from-red-500 to-red-600 hover:from-red-400 hover:to-red-500 text-white px-8 py-3.5 rounded-full font-semibold text-base transition-all shadow-md hover:shadow-lg active:scale-95 cursor-pointer"
              >
                <PhoneOff className="w-5 h-5" aria-hidden="true" />
                End Call
              </button>
            </>
          ) : (
            <div className="flex items-center gap-2.5 text-slate-500 px-6 py-3.5 glass rounded-full">
              <div className="w-2 h-2 bg-brand-500 rounded-full soft-pulse" />
              <span className="text-sm font-medium">{cfg.label}</span>
            </div>
          )}
        </div>
      </div>

      {/* Right Column: Live Transcript */}
      <div className="lg:col-span-7 flex flex-col h-[480px] lg:h-auto min-h-0">
        <LiveTranscript turns={turns} interimText={interimText} streamingAgentText={streamingAgentText} />
      </div>
    </div>
  );

  return (
    <>
      {livekitToken && livekitUrl && (isCallActive || status === 'connecting') ? (
        <LiveKitRoom
          serverUrl={livekitUrl}
          token={livekitToken}
          connect={isCallActive || status === 'connecting'}
          // audio is true once at connect. Mute toggling is driven inside MicToggle via
          // localParticipant.setMicrophoneEnabled — flipping the LiveKitRoom audio prop
          // would re-publish the track and can drop frames during a live call.
          audio={true}
          video={false}
          onDisconnected={handleEndCall}
          onConnected={() => {
            console.log('[VoiceCall] LiveKitRoom connected — emitting client:ready');
            socketRef.current?.emit('client:ready');
          }}
        >
          <RoomAudioRenderer />
          {innerContent}
        </LiveKitRoom>
      ) : (
        innerContent
      )}
    </>
  );
}
