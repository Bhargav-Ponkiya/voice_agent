import React from 'react';
import { CallFlowEntry, CallFlowStage } from '../../types';
import { clsx } from 'clsx';
import { GitBranch } from 'lucide-react';

interface Props {
  callFlow: CallFlowEntry[];
}

const STAGE_CONFIG: Record<CallFlowStage, { label: string; gradient: string; text: string; border: string }> = {
  'Greeting':           { label: 'Greeting',    gradient: 'from-sky-50/70 to-sky-100/40',       text: 'text-sky-850 font-bold',    border: 'border-sky-200/80' },
  'Discovery':          { label: 'Discovery',   gradient: 'from-violet-50/70 to-violet-100/40', text: 'text-violet-850 font-bold', border: 'border-violet-200/80' },
  'Resolution Attempt': { label: 'Resolution',  gradient: 'from-emerald-50/70 to-emerald-100/40', text: 'text-emerald-850 font-bold', border: 'border-emerald-200/80' },
  'Objection Handling': { label: 'Objection',   gradient: 'from-amber-50/70 to-amber-100/40',   text: 'text-amber-850 font-bold',  border: 'border-amber-200/80' },
  'Escalation':         { label: 'Escalation',  gradient: 'from-red-50/70 to-red-100/40',       text: 'text-red-850 font-bold',    border: 'border-red-200/80' },
  'Close':              { label: 'Close',       gradient: 'from-teal-50/70 to-teal-100/40',     text: 'text-teal-850 font-bold',   border: 'border-teal-200/80' },
};

const STAGE_BAR_COLOR: Record<CallFlowStage, string> = {
  'Greeting': 'bg-sky-500',
  'Discovery': 'bg-violet-500',
  'Resolution Attempt': 'bg-emerald-500',
  'Objection Handling': 'bg-amber-500',
  'Escalation': 'bg-red-500',
  'Close': 'bg-teal-500',
};

const STAGE_ORDER: CallFlowStage[] = [
  'Greeting', 'Discovery', 'Resolution Attempt', 'Objection Handling', 'Escalation', 'Close'
];

export default function CallFlowTimeline({ callFlow }: Props) {
  if (!callFlow?.length) {
    return (
      <div className="glass rounded-3xl p-6 fade-up">
        <h3 className="text-base font-semibold flex items-center gap-2">
          <GitBranch className="w-4 h-4 text-brand-400" />
          Call Flow
        </h3>
        <div className="h-20 flex items-center justify-center text-slate-400 text-sm">No call flow data</div>
      </div>
    );
  }

  const stageCounts: Partial<Record<CallFlowStage, number>> = {};
  for (const entry of callFlow) {
    stageCounts[entry.stage] = (stageCounts[entry.stage] || 0) + 1;
  }
  const total = callFlow.length;
  const allStages = Array.from(new Set([...STAGE_ORDER, ...Object.keys(stageCounts)]));

  return (
    <div className="glass rounded-3xl p-6 space-y-5 fade-up">
      <h3 className="text-base font-semibold flex items-center gap-2 text-slate-800">
        <GitBranch className="w-4 h-4 text-brand-500" />
        Call Flow Timeline
      </h3>

      {/* Proportional stage bar */}
      <div className="flex h-3 rounded-full overflow-hidden gap-0.5 bg-slate-100 p-0.5 border border-slate-200">
        {allStages.map((stage) => {
          const count = stageCounts[stage as CallFlowStage] || 0;
          if (!count) return null;
          const color = STAGE_BAR_COLOR[stage as CallFlowStage] || 'bg-slate-500';
          return (
            <div
              key={stage}
              title={`${stage}: ${count} turns`}
              className={`${color} h-full rounded-full transition-all`}
              style={{ width: `${(count / total) * 100}%`, minWidth: '4px' }}
            />
          );
        })}
      </div>

      {/* Legend chips */}
      <div className="flex flex-wrap gap-1.5">
        {allStages.map((stage) => {
          const count = stageCounts[stage as CallFlowStage];
          if (!count) return null;
          const cfg = STAGE_CONFIG[stage as CallFlowStage] || { label: stage, gradient: 'from-slate-50/70 to-slate-100/40', text: 'text-slate-850 font-bold', border: 'border-slate-200/80' };
          return (
            <div
              key={stage}
              className={clsx(
                'flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-xs bg-gradient-to-br shadow-xs',
                cfg.gradient, cfg.border, cfg.text
              )}
            >
              <span className="font-semibold">{cfg.label}</span>
              <span className="opacity-70 tabular-nums font-bold">{count}</span>
            </div>
          );
        })}
      </div>

      {/* Turn list */}
      <div className="space-y-1.5 max-h-64 overflow-y-auto scrollbar-thin pr-1">
        {callFlow.map((entry) => {
          const cfg = STAGE_CONFIG[entry.stage] || { label: entry.stage || 'Unknown', gradient: 'from-slate-50/70 to-slate-100/40', text: 'text-slate-850 font-bold', border: 'border-slate-200/80' };
          return (
            <div
              key={entry.turn}
              className={clsx(
                'flex items-start gap-3 px-3 py-2 rounded-xl border text-sm bg-gradient-to-r shadow-xs',
                cfg.gradient, cfg.border
              )}
            >
              <span className="font-mono text-slate-400 text-[10px] mt-0.5 flex-shrink-0 w-14 tabular-nums">
                {(entry.timestamp || '').replace(/[\[\]]/g, '') || `Turn ${entry.turn ?? ''}`}
              </span>
              <span className={clsx('text-[10px] font-bold flex-shrink-0 w-14 uppercase tracking-wider', entry.speaker === 'Agent' ? 'text-brand-600' : 'text-slate-500')}>
                {entry.speaker === 'Agent' ? 'Sarah' : 'You'}
              </span>
              <span className={clsx('text-[10px] font-bold flex-shrink-0 uppercase tracking-wider min-w-[80px]', cfg.text)}>
                {cfg.label}
              </span>
              <span className="text-slate-600 text-xs truncate">{entry.text_preview}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
