import React, { useState } from 'react';
import { PromptVersion } from '../../types';
import { clsx } from 'clsx';
import { ChevronDown, ChevronRight, GitBranch, Zap, Sparkles } from 'lucide-react';

interface Props {
  versions: PromptVersion[];
}

function DiffView({ v1, v2 }: { v1: string; v2: string }) {
  const lines1 = v1.split('\n');
  const lines2 = v2.split('\n');
  const addedLines = lines2.filter((l) => !lines1.includes(l) && l.trim());
  const removedLines = lines1.filter((l) => !lines2.includes(l) && l.trim());

  return (
    <div className="space-y-1.5 text-xs font-mono">
      {removedLines.slice(0, 5).map((line, i) => (
        <div key={`r${i}`} className="flex gap-2 bg-red-50 border border-red-150 px-3 py-1.5 rounded-lg">
          <span className="text-red-500 font-bold flex-shrink-0 select-none">−</span>
          <span className="text-red-800 truncate">{line}</span>
        </div>
      ))}
      {addedLines.slice(0, 5).map((line, i) => (
        <div key={`a${i}`} className="flex gap-2 bg-emerald-50 border border-emerald-150 px-3 py-1.5 rounded-lg">
          <span className="text-emerald-600 font-bold flex-shrink-0 select-none">+</span>
          <span className="text-emerald-800 truncate">{line}</span>
        </div>
      ))}
      {(addedLines.length === 0 && removedLines.length === 0) && (
        <p className="text-slate-400 px-3 py-2">No visible diff</p>
      )}
    </div>
  );
}

export default function PromptVersionHistory({ versions }: Props) {
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);

  if (!versions?.length) {
    return (
      <div className="glass rounded-3xl p-6">
        <h3 className="text-base font-semibold">Prompt Version History</h3>
        <div className="h-20 flex items-center justify-center text-slate-400 text-sm">No versions yet</div>
      </div>
    );
  }

  const sorted = [...versions].sort((a, b) => b.version - a.version);

  return (
    <div className="glass rounded-3xl p-6 space-y-4 fade-up">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-ai-50 border border-ai-100 flex items-center justify-center shadow-xs">
            <GitBranch className="w-4 h-4 text-ai-600" />
          </div>
          <h3 className="text-base font-bold text-slate-800">Prompt Evolution</h3>
        </div>
        <span className="px-2.5 py-0.5 bg-ai-50 text-ai-700 rounded-full text-xs font-semibold border border-ai-200">
          {versions.length} version{versions.length !== 1 ? 's' : ''}
        </span>
        <p className="text-xs text-slate-400 ml-auto hidden sm:block font-medium">
          Self-healed automatically after each call
        </p>
      </div>

      <div className="space-y-2.5">
        {sorted.map((version, idx) => {
          const isLatest = idx === 0;
          const prevVersion = sorted[idx + 1];
          const isExpanded = expandedVersion === version.version;

          return (
            <div
              key={version.version}
              className={clsx(
                'rounded-2xl overflow-hidden transition-all border',
                isLatest
                  ? 'border-ai-300 bg-gradient-to-br from-ai-50/70 to-ai-100/30'
                  : 'border-slate-205 bg-white shadow-xs'
              )}
            >
              <button
                className="w-full flex items-start gap-3 p-4 text-left hover:bg-slate-50/50 transition-colors cursor-pointer"
                onClick={() => setExpandedVersion(isExpanded ? null : version.version)}
              >
                <div className="flex-shrink-0 mt-0.5">
                  {isExpanded ? (
                    <ChevronDown className="w-4 h-4 text-slate-400" />
                  ) : (
                    <ChevronRight className="w-4 h-4 text-slate-400" />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={clsx('text-sm font-bold tabular-nums', isLatest ? 'text-ai-700' : 'text-slate-500')}>
                      v{version.version}
                    </span>
                    {isLatest && (
                      <span className="flex items-center gap-1 px-2 py-0.5 bg-ai-500 text-white rounded-full text-[9px] font-bold uppercase tracking-wider shadow-xs">
                        <Zap className="w-2.5 h-2.5 fill-white" />
                        Active
                      </span>
                    )}
                    {version.triggeredByCallId && (
                      <span className="text-[10px] text-slate-400 font-mono">
                        from #{version.triggeredByCallId.slice(0, 8)}
                      </span>
                    )}
                    {version.rubricScoreBefore !== undefined && (
                      <span className="text-[10px] text-slate-400">
                        was {version.rubricScoreBefore}/100
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-slate-700 font-medium mt-1.5 line-clamp-1">{version.summary}</p>
                  {version.expectedImprovement && (
                    <p className="text-xs text-ai-600 mt-1 flex items-center gap-1 font-semibold">
                      <Sparkles className="w-3.5 h-3.5" />
                      {version.expectedImprovement}
                    </p>
                  )}
                </div>

                <div className="flex-shrink-0 text-xs text-slate-400 mt-0.5 font-medium">
                  {new Date(version.createdAt).toLocaleDateString()}
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-slate-200 p-4 space-y-4 bg-white">
                  {version.patches?.length > 0 && (
                    <div className="space-y-2.5">
                      <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Patches Applied</h4>
                      {version.patches.map((patch, pi) => (
                        <div key={pi} className="bg-slate-50 border border-slate-205 rounded-xl p-3 space-y-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={clsx(
                              'px-2 py-0.5 rounded-md text-[9px] font-bold uppercase tracking-wider border',
                              patch.patch_type === 'addition'
                                ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                                : 'bg-amber-50 border-amber-200 text-amber-700'
                            )}>
                              {patch.patch_type}
                            </span>
                            <span className="text-xs text-slate-700 font-semibold">{patch.target_section}</span>
                          </div>
                          <p className="text-xs text-slate-800 leading-relaxed font-medium">{patch.instruction}</p>
                          <p className="text-xs text-slate-500 italic">→ {patch.reasoning}</p>
                          {patch.example_added && (
                            <div className="bg-white rounded-lg px-3 py-2 text-xs text-slate-500 border border-slate-200 shadow-xs">
                              <span className="font-semibold text-slate-400">Example added: </span>{patch.example_added}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {prevVersion && (
                    <div className="space-y-2">
                      <h4 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">
                        Diff vs v{prevVersion.version}
                      </h4>
                      <DiffView v1={prevVersion.systemPrompt} v2={version.systemPrompt} />
                    </div>
                  )}

                  <details className="group">
                    <summary className="text-xs text-slate-500 cursor-pointer hover:text-slate-800 transition-colors select-none font-medium">
                      View full prompt →
                    </summary>
                    <pre className="mt-2 text-xs text-slate-700 bg-slate-50 rounded-xl p-4 overflow-x-auto whitespace-pre-wrap leading-relaxed border border-slate-200 font-mono shadow-inner">
                      {version.systemPrompt}
                    </pre>
                  </details>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
