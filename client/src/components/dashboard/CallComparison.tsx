import React from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell } from 'recharts';
import { Scorecard } from '../../types';
import { TrendingUp, TrendingDown, Minus, BarChart3 } from 'lucide-react';

interface Props {
  analyses: Scorecard[];
}

function CustomTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3 text-xs shadow-lg">
      <p className="text-slate-500 mb-1">{label}</p>
      <p className="text-slate-800 font-bold text-lg tabular-nums">{payload[0].value}<span className="text-slate-400 font-normal text-sm"> / 100</span></p>
      <p className="text-brand-650 mt-1 text-[11px] font-semibold">Prompt v{payload[0].payload.prompt_version}</p>
    </div>
  );
}

export default function CallComparison({ analyses }: Props) {
  if (!analyses?.length) {
    return (
      <div className="glass rounded-3xl p-6 fade-up">
        <h3 className="text-base font-semibold flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-brand-400" />
          Score Trend
        </h3>
        <div className="h-40 flex items-center justify-center text-slate-400 text-sm">
          Complete more calls to see trend
        </div>
      </div>
    );
  }

  const chartData = analyses.slice(0, 10).reverse().map((a, i) => ({
    name: `#${i + 1}`,
    score: a.rubric_score,
    callId: a.callId,
    prompt_version: a.prompt_version,
  }));

  const latest = analyses[0];
  const previous = analyses[1];
  const scoreDelta = previous ? latest.rubric_score - previous.rubric_score : 0;

  const avgFillerWords = analyses.reduce((s, a) => s + (a.agent_signals?.filler_words || 0), 0) / analyses.length;
  const avgUnresolved = analyses.reduce((s, a) => s + (a.agent_signals?.unresolved_objections || 0), 0) / analyses.length;

  const deltaConfig = scoreDelta > 0
    ? { color: 'text-emerald-700 bg-emerald-50 border-emerald-200', icon: TrendingUp }
    : scoreDelta < 0
    ? { color: 'text-red-700 bg-red-50 border-red-200', icon: TrendingDown }
    : { color: 'text-slate-500 bg-slate-50 border-slate-200', icon: Minus };
  const DeltaIcon = deltaConfig.icon;

  return (
    <div className="glass rounded-3xl p-6 space-y-5 fade-up">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-semibold flex items-center gap-2 text-slate-800">
          <BarChart3 className="w-4 h-4 text-brand-500" />
          Score Trend
        </h3>
        {analyses.length >= 2 && (
          <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border ${deltaConfig.color}`}>
            <DeltaIcon className="w-3 h-3" />
            {scoreDelta > 0 ? '+' : ''}{scoreDelta}
          </span>
        )}
      </div>

      <ResponsiveContainer width="100%" height={160}>
        <BarChart data={chartData} margin={{ top: 5, right: 5, left: -25, bottom: 0 }}>
          <defs>
            <linearGradient id="barGradGood" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.70 0.18 145)" />
              <stop offset="100%" stopColor="oklch(0.55 0.16 145)" />
            </linearGradient>
            <linearGradient id="barGradMid" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.75 0.15 80)" />
              <stop offset="100%" stopColor="oklch(0.60 0.13 80)" />
            </linearGradient>
            <linearGradient id="barGradBad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.65 0.18 25)" />
              <stop offset="100%" stopColor="oklch(0.50 0.16 25)" />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke="var(--color-surface-3)" vertical={false} />
          <XAxis dataKey="name" tick={{ fill: 'oklch(0.45 0.01 220)', fontSize: 11 }} tickLine={false} axisLine={false} />
          <YAxis domain={[0, 100]} tick={{ fill: 'oklch(0.45 0.01 220)', fontSize: 11 }} tickLine={false} axisLine={false} />
          <Tooltip content={<CustomTooltip />} cursor={{ fill: 'var(--color-surface-2)' }} />
          <Bar dataKey="score" radius={[8, 8, 0, 0]}>
            {chartData.map((entry, i) => (
              <Cell
                key={i}
                fill={
                  entry.score >= 80 ? 'url(#barGradGood)' :
                  entry.score >= 60 ? 'url(#barGradMid)' :
                  'url(#barGradBad)'
                }
                fillOpacity={i === chartData.length - 1 ? 1 : 0.65}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>

      <div className="grid grid-cols-2 gap-2.5 pt-3 border-t border-slate-200">
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 shadow-xs">
          <p className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Avg filler words</p>
          <p className={`text-xl font-bold mt-1.5 tabular-nums ${avgFillerWords > 5 ? 'text-amber-600' : 'text-emerald-650'}`}>
            {avgFillerWords.toFixed(1)}
          </p>
        </div>
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 shadow-xs">
          <p className="text-[10px] text-slate-400 uppercase tracking-wider font-semibold">Avg unresolved</p>
          <p className={`text-xl font-bold mt-1.5 tabular-nums ${avgUnresolved > 0 ? 'text-red-650' : 'text-emerald-650'}`}>
            {avgUnresolved.toFixed(1)}
          </p>
        </div>
      </div>
    </div>
  );
}
