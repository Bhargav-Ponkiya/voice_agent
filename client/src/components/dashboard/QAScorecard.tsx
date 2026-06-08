import React from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Award } from 'lucide-react';
import { Scorecard } from '../../types';
import { clsx } from 'clsx';

interface Props {
  scorecard: Scorecard;
}

const rubricItems = [
  { key: 'greeted_within_5s', label: 'Greeted within 5 seconds', points: 20 },
  { key: 'issue_acknowledged_before_solution', label: 'Issue acknowledged first', points: 25 },
  { key: 'policy_explained_clearly', label: 'Policy explained clearly', points: 20 },
  { key: 'call_closed_with_resolution', label: 'Closed with resolution', points: 20 },
  { key: 'no_dead_air_over_3s', label: 'No dead air over 3 sec', points: 15 },
] as const;

function ScoreRing({ score }: { score: number }) {
  const color = score >= 80 ? 'oklch(0.70 0.20 145)' : score >= 60 ? 'oklch(0.78 0.18 80)' : 'oklch(0.62 0.22 25)';
  const glowColor = score >= 80 ? '0 0 32px oklch(0.70 0.20 145 / 0.4)' :
                    score >= 60 ? '0 0 32px oklch(0.78 0.18 80 / 0.4)' :
                                  '0 0 32px oklch(0.62 0.22 25 / 0.4)';
  const circumference = 2 * Math.PI * 40;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div className="relative w-32 h-32 flex items-center justify-center" style={{ filter: `drop-shadow(${glowColor})` }}>
      <svg className="w-32 h-32 -rotate-90" viewBox="0 0 100 100">
        <defs>
          <linearGradient id="scoreGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor={color} stopOpacity="1" />
            <stop offset="100%" stopColor={color} stopOpacity="0.7" />
          </linearGradient>
        </defs>
        <circle cx="50" cy="50" r="40" fill="none" stroke="var(--color-surface-3)" strokeWidth="8" />
        <circle
          cx="50" cy="50" r="40" fill="none"
          stroke="url(#scoreGrad)" strokeWidth="8"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 1.2s var(--ease-out-quart)' }}
        />
      </svg>
      <div className="absolute text-center">
        <div className="text-3xl font-bold tracking-tight" style={{ color }}>{score}</div>
        <div className="text-[10px] text-gray-500 uppercase tracking-widest mt-0.5">Score</div>
      </div>
    </div>
  );
}

export default function QAScorecard({ scorecard }: Props) {
  const details = scorecard.rubric_details;
  const flags = scorecard.flags;
  const grade = scorecard.rubric_score >= 90 ? 'Excellent' :
                scorecard.rubric_score >= 75 ? 'Good' :
                scorecard.rubric_score >= 60 ? 'Needs work' :
                'Poor';

  return (
    <div className="glass rounded-3xl p-6 space-y-6 fade-up">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-xs text-gray-500 uppercase tracking-widest mb-2">
            <Award className="w-3.5 h-3.5" />
            QA Scorecard
          </div>
          <h3 className="text-2xl font-bold tracking-tight">{grade}</h3>
          <p className="text-xs text-gray-500 mt-1">Prompt v{scorecard.prompt_version}</p>
        </div>
        <ScoreRing score={scorecard.rubric_score} />
      </div>

      {/* Rubric */}
      <div className="space-y-2">
        {rubricItems.map((item) => {
          const passed = details[item.key];
          return (
            <div
              key={item.key}
              className={clsx(
                'flex items-center justify-between px-4 py-2.5 rounded-xl border transition-colors',
                passed
                  ? 'bg-emerald-50/50 border-emerald-200 text-slate-700'
                  : 'bg-red-50/50 border-red-200 text-slate-700'
              )}
            >
              <div className="flex items-center gap-3">
                {passed ? (
                  <CheckCircle2 className="w-4 h-4 text-emerald-600 flex-shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                )}
                <span className="text-sm font-medium">{item.label}</span>
              </div>
              <span className={clsx('text-sm font-bold tabular-nums', passed ? 'text-emerald-650' : 'text-red-650/70')}>
                {passed ? `+${item.points}` : '0'}
              </span>
            </div>
          );
        })}
      </div>

      {/* Signals */}
      <div className="grid grid-cols-3 gap-2.5">
        {[
          { value: scorecard.agent_signals.filler_words, label: 'Filler words', warn: scorecard.agent_signals.filler_words > 5 },
          { value: scorecard.agent_signals.avg_response_length_words, label: 'Avg words', warn: scorecard.agent_signals.avg_response_length_words < 10 || scorecard.agent_signals.avg_response_length_words > 80 },
          { value: scorecard.agent_signals.unresolved_objections, label: 'Unresolved', warn: scorecard.agent_signals.unresolved_objections > 0, danger: scorecard.agent_signals.unresolved_objections > 0 },
        ].map((stat, i) => (
          <div key={i} className="bg-slate-50 border border-slate-200 rounded-xl p-3 text-center shadow-xs">
            <div className={clsx(
              'text-2xl font-bold tabular-nums',
              stat.danger ? 'text-red-600' : stat.warn ? 'text-amber-600' : 'text-emerald-650'
            )}>
              {stat.value}
            </div>
            <div className="text-[10px] text-slate-400 mt-1.5 uppercase tracking-wider font-semibold">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Flags */}
      {flags.length > 0 && (
        <div className="space-y-2 pt-2">
          <h4 className="text-xs font-semibold text-slate-400 flex items-center gap-2 uppercase tracking-widest">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
            Flags · {flags.length}
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {flags.map((flag, i) => (
              <span key={i} className="px-2.5 py-1 bg-amber-50 border border-amber-250 text-amber-800 text-[11px] rounded-lg font-mono">
                {flag}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
