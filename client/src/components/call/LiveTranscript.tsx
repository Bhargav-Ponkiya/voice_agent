import React, { useEffect, useRef } from 'react';
import { LiveTurn } from '../../types';
import { clsx } from 'clsx';
import { MessageSquare, Bot, User } from 'lucide-react';

interface Props {
  turns: LiveTurn[];
  interimText: string;
  /** Real-time Gemini text chunks streaming in before the full response is committed */
  streamingAgentText?: string;
}

export default React.memo(function LiveTranscript({ turns, interimText, streamingAgentText }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [turns, interimText, streamingAgentText]);

  const agentTurns = turns.filter((t) => !t.isInterim && t.speaker === 'Agent').length;
  const customerTurns = turns.filter((t) => !t.isInterim && t.speaker === 'Customer').length;

  const hasContent = turns.length > 0 || interimText || streamingAgentText;

  return (
    <div className="h-full glass rounded-2xl flex flex-col overflow-hidden">
      {/* ── Header ── */}
      <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100 flex-shrink-0">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-brand-500" aria-hidden="true" />
          <span className="text-sm font-semibold text-slate-700">Live Transcript</span>
        </div>
        {turns.length > 0 && (
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span className="flex items-center gap-1">
              <Bot className="w-3 h-3 text-brand-500" aria-hidden="true" />
              {agentTurns}
            </span>
            <span className="flex items-center gap-1">
              <User className="w-3 h-3 text-slate-400" aria-hidden="true" />
              {customerTurns}
            </span>
            <span className="font-mono">{turns.length} turns</span>
          </div>
        )}
      </div>

      {/* ── Messages ── */}
      {!hasContent ? (
        <div className="flex-1 flex flex-col items-center justify-center gap-3.5 px-6 py-12 text-center min-h-[260px]">
          <div className="w-12 h-12 rounded-2xl bg-brand-50 border border-brand-100 flex items-center justify-center shadow-sm">
            <MessageSquare className="w-5 h-5 text-brand-500" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-slate-800 mb-1">Connecting to NovaTel...</h3>
            <p className="text-xs text-slate-500">Sarah will greet you once the call connects.</p>
          </div>
        </div>
      ) : (
        <div
          className="flex-1 overflow-y-auto p-5 space-y-4 scrollbar-thin"
          role="log"
          aria-label="Call transcript"
          aria-live="polite"
        >
          {turns.map((turn, idx) => (
            <TurnBubble key={turn.id} turn={turn} isLatest={idx === turns.length - 1} />
          ))}

          {/* Real-time agent streaming transcript — shown while Gemini is generating */}
          {streamingAgentText && (
            <div className="flex flex-col items-start gap-1.5 fade-up">
              <div className="flex items-center gap-2 px-1">
                <Bot className="w-3 h-3 text-brand-500" aria-hidden="true" />
                <span className="text-xs font-semibold tracking-wide uppercase opacity-90 text-brand-600">
                  Sarah
                </span>
                <span className="text-[9px] text-emerald-500 font-semibold animate-pulse">
                  responding…
                </span>
              </div>
              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-tl-none bg-slate-50 border border-brand-200/60 text-slate-700 text-sm leading-relaxed shadow-xs">
                {streamingAgentText}
                {/* Blinking cursor to show stream is live */}
                <span
                  className="inline-block w-0.5 h-3.5 bg-brand-400 ml-0.5 align-middle animate-[blink_1s_step-end_infinite]"
                  aria-hidden="true"
                />
              </div>
            </div>
          )}

          {/* Interim / in-progress customer speech */}
          {interimText && (
            <div className="flex flex-col items-end gap-1.5">
              <div className="flex items-center gap-1.5 mb-1.5">
                <span className="text-xs font-semibold text-slate-500 tracking-wide uppercase">
                  You
                </span>
                <span className="text-[9px] text-brand-500 font-semibold animate-pulse">
                  speaking…
                </span>
              </div>
              <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-tr-none bg-brand-50/60 border border-brand-200/70 text-brand-900/80 text-sm italic shadow-xs">
                {interimText}
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
});

// ─── Turn Bubble ─────────────────────────────────────────────────────────────

const TurnBubble = React.memo(function TurnBubble({ turn, isLatest }: { turn: LiveTurn; isLatest: boolean }) {
  const isAgent = turn.speaker === 'Agent';

  return (
    <div
      className={clsx(
        'flex flex-col gap-1.5',
        isAgent ? 'items-start' : 'items-end',
        isLatest && 'fade-up'
      )}
    >
      <div className="flex items-center gap-2 px-1">
        {isAgent ? (
          <Bot className="w-3 h-3 text-brand-500" aria-hidden="true" />
        ) : (
          <User className="w-3 h-3 text-slate-400" aria-hidden="true" />
        )}
        <span
          className={clsx(
            'text-[10px] font-bold tracking-wider uppercase',
            isAgent ? 'text-brand-600' : 'text-slate-500'
          )}
        >
          {isAgent ? 'Sarah' : 'You'}
        </span>
        <span className="text-slate-300 text-[10px] font-mono">{turn.timestamp}</span>
      </div>
      <div
        className={clsx(
          'max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed shadow-xs',
          isAgent
            ? 'bg-slate-50 text-slate-700 rounded-tl-none border border-slate-200'
            : 'bg-gradient-to-br from-brand-500 to-brand-600 text-white rounded-tr-none border border-brand-600/10'
        )}
      >
        {turn.text}
      </div>
    </div>
  );
});
