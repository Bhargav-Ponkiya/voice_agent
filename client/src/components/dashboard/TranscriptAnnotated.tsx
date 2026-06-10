import React, { useState } from 'react';
import { Scorecard, TranscriptTurn as Turn } from '../../types';
import { clsx } from 'clsx';
import { AlertTriangle, FileText, Eye, EyeOff } from 'lucide-react';

interface Props {
  turns: Turn[];
  scorecard: Scorecard;
}

function findMatchingTurnIndex(
  timestamp: string,
  speaker: string | undefined,
  textPreview: string,
  turns: Turn[]
): number | null {
  const cleanTime = (timestamp || '').replace(/[\[\]\s]/g, '');
  if (!cleanTime) return null;

  let candidates = turns;
  if (speaker) {
    candidates = turns.filter(t => t.speaker.toLowerCase() === speaker.toLowerCase());
  }

  const timeMatches = candidates.filter(t => t.timestamp.replace(/[\[\]\s]/g, '') === cleanTime);
  
  if (timeMatches.length === 1) {
    return timeMatches[0].turnIndex;
  }

  if (textPreview) {
    const cleanPreview = textPreview.toLowerCase().trim().replace(/[^a-z0-9]/g, '');
    const pool = timeMatches.length > 0 ? timeMatches : candidates;
    
    let bestMatch: Turn | null = null;
    let maxOverlap = 0;
    
    for (const cand of pool) {
      const candText = cand.text.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (candText.includes(cleanPreview) || cleanPreview.includes(candText)) {
        return cand.turnIndex;
      }
      
      const previewWords = textPreview.toLowerCase().split(/\s+/).filter(Boolean);
      const candWords = cand.text.toLowerCase().split(/\s+/).filter(Boolean);
      const overlap = previewWords.filter(w => candWords.includes(w)).length;
      if (overlap > maxOverlap) {
        maxOverlap = overlap;
        bestMatch = cand;
      }
    }
    
    if (bestMatch && maxOverlap > 0) {
      return bestMatch.turnIndex;
    }
  }

  const anyTimeMatch = turns.find(t => t.timestamp.replace(/[\[\]\s]/g, '') === cleanTime);
  if (anyTimeMatch) {
    return anyTimeMatch.turnIndex;
  }

  return null;
}

export default function TranscriptAnnotated({ turns, scorecard }: Props) {
  const [showAnnotations, setShowAnnotations] = useState(true);

  const failureByTimestamp: Record<string, typeof scorecard.failure_moments[0]> = {};
  for (const f of scorecard.failure_moments || []) {
    failureByTimestamp[f.timestamp] = f;
  }

  const stageByTurn: Record<number, string> = {};
  const sentimentByTurn: Record<number, string> = {};

  for (const cf of scorecard.call_flow || []) {
    const matchIdx = findMatchingTurnIndex(cf.timestamp, cf.speaker, cf.text_preview, turns);
    const finalKey = matchIdx !== null ? matchIdx : (cf.turn + 1);
    stageByTurn[finalKey] = cf.stage;
  }
  for (const sa of scorecard.sentiment_arc || []) {
    const isGreeting = sa.text_preview && sa.text_preview.toLowerCase().startsWith('hello, thank you');
    const speaker = isGreeting ? 'Agent' : 'Customer';
    const matchIdx = findMatchingTurnIndex(sa.timestamp, speaker, sa.text_preview, turns);
    const finalKey = matchIdx !== null ? matchIdx : (sa.turn + 1);
    sentimentByTurn[finalKey] = sa.sentiment;
  }

  const SENTIMENT_DOT: Record<string, string> = {
    positive: 'bg-emerald-400', neutral: 'bg-sky-400',
    frustrated: 'bg-amber-400', angry: 'bg-red-400',
  };

  const SEVERITY_CONFIG: Record<string, { bg: string; border: string; text: string; iconColor: string }> = {
    high:   { bg: 'bg-red-50/80',    border: 'border-red-200',    text: 'text-red-800',    iconColor: 'text-red-600' },
    medium: { bg: 'bg-amber-50/80',  border: 'border-amber-200',  text: 'text-amber-800',  iconColor: 'text-amber-600' },
    low:    { bg: 'bg-slate-50',  border: 'border-slate-200',      text: 'text-slate-650',   iconColor: 'text-slate-500' },
  };

  return (
    <div className="glass rounded-3xl p-6 space-y-4 fade-up">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold flex items-center gap-2 text-slate-800">
          <FileText className="w-4 h-4 text-brand-500" />
          Annotated Transcript
        </h3>
        <button
          onClick={() => setShowAnnotations((v) => !v)}
          className="text-xs text-slate-500 hover:text-slate-800 transition-colors flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white hover:bg-slate-50 border border-slate-200/80 shadow-xs cursor-pointer"
        >
          {showAnnotations ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
          {showAnnotations ? 'Hide' : 'Show'} annotations
        </button>
      </div>

      <div className="space-y-4 max-h-[600px] overflow-y-auto scrollbar-thin pr-1">
        {turns.map((turn, idx) => {
          const isCustomer = turn.speaker === 'Customer';
          const turnFailure = failureByTimestamp[turn.timestamp];
          const stage = stageByTurn[turn.turnIndex];
          const sentiment = isCustomer ? sentimentByTurn[turn.turnIndex] : undefined;

          return (
            <div key={idx} className={clsx('flex flex-col gap-1.5', isCustomer ? 'items-end' : 'items-start')}>
              <div className="flex items-center gap-2 flex-wrap px-1">
                <span className={clsx('text-[10px] font-bold uppercase tracking-wider', isCustomer ? 'text-slate-500' : 'text-brand-650')}>
                  {isCustomer ? 'Customer' : 'Sarah'}
                </span>
                <span className="text-slate-400 text-[10px] font-mono tabular-nums">{turn.timestamp}</span>
                {showAnnotations && stage && (
                  <span className="px-1.5 py-0.5 text-[9px] bg-slate-50 text-slate-500 rounded border border-slate-200 uppercase font-semibold tracking-wider">
                    {stage}
                  </span>
                )}
                {showAnnotations && sentiment && (
                  <div className="flex items-center gap-1 text-[10px] text-slate-400">
                    <div className={clsx('w-2 h-2 rounded-full', SENTIMENT_DOT[sentiment])} />
                    <span className="capitalize font-medium">{sentiment}</span>
                  </div>
                )}
              </div>

              <div
                className={clsx(
                  'max-w-[85%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed shadow-xs',
                  isCustomer
                    ? 'bg-sky-50 text-sky-900 rounded-tr-none border border-sky-200/70'
                    : 'bg-slate-50 text-slate-700 rounded-tl-none border border-slate-200'
                )}
              >
                {turn.text}
              </div>

              {showAnnotations && turnFailure && (() => {
                const sc = SEVERITY_CONFIG[turnFailure.severity];
                return (
                  <div className={clsx('max-w-[85%] flex items-start gap-2.5 px-3.5 py-2.5 rounded-xl border text-xs shadow-xs', sc.bg, sc.border)}>
                    <AlertTriangle className={clsx('w-4 h-4 flex-shrink-0 mt-0.5', sc.iconColor)} />
                    <div className={sc.text}>
                      <span className="font-bold capitalize">{(turnFailure.type || 'Failure').replace(/_/g, ' ')}</span>
                      <span className="opacity-70"> — </span>
                      <span className="font-medium">{turnFailure.description}</span>
                    </div>
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    </div>
  );
}
