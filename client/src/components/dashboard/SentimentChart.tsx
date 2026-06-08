import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Area, AreaChart,
} from 'recharts';
import { SentimentArcEntry, Sentiment } from '../../types';
import { TrendingUp, TrendingDown, Minus, Activity } from 'lucide-react';

interface Props {
  sentimentArc: SentimentArcEntry[];
}

const SENTIMENT_SCORE: Record<Sentiment, number> = {
  positive: 4, neutral: 3, frustrated: 2, angry: 1,
};

const SENTIMENT_COLOR: Record<Sentiment, string> = {
  positive: 'oklch(0.72 0.20 145)',
  neutral: 'oklch(0.70 0.15 240)',
  frustrated: 'oklch(0.76 0.18 70)',
  angry: 'oklch(0.62 0.22 25)',
};

const SENTIMENT_LABELS: Record<number, string> = {
  4: 'Positive', 3: 'Neutral', 2: 'Frustrated', 1: 'Angry',
};

function CustomDot(props: any) {
  const { cx, cy, payload } = props;
  if (!payload) return null;
  const color = SENTIMENT_COLOR[payload.sentiment as Sentiment];
  const isEscalation = payload.escalation_trigger;

  return (
    <g>
      {isEscalation && (
        <circle cx={cx} cy={cy} r={11} fill="none" stroke="oklch(0.62 0.22 25)" strokeWidth={1.5} strokeDasharray="3 2" opacity={0.8} />
      )}
      <circle cx={cx} cy={cy} r={isEscalation ? 6 : 5} fill={color} stroke="var(--color-surface-0)" strokeWidth={2} />
    </g>
  );
}

function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-3 text-xs shadow-lg max-w-xs">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-2.5 h-2.5 rounded-full" style={{ background: SENTIMENT_COLOR[d.sentiment as Sentiment] }} />
        <span className="font-bold text-slate-700 capitalize">{d.sentiment}</span>
        {d.escalation_trigger && (
          <span className="px-1.5 py-0.5 bg-red-50 border border-red-200 text-red-700 rounded text-[9px] font-bold uppercase tracking-wider">Escalation</span>
        )}
      </div>
      <p className="text-slate-400 mt-1 font-mono">{d.timestamp}</p>
      <p className="text-slate-600 mt-2 leading-relaxed italic">&ldquo;{d.text_preview}&rdquo;</p>
    </div>
  );
}

export default function SentimentChart({ sentimentArc }: Props) {
  if (!sentimentArc?.length) {
    return (
      <div className="glass rounded-3xl p-6 fade-up">
        <h3 className="text-base font-semibold flex items-center gap-2">
          <Activity className="w-4 h-4 text-brand-400" />
          Sentiment Arc
        </h3>
        <div className="h-40 flex items-center justify-center text-slate-400 text-sm">No sentiment data</div>
      </div>
    );
  }

  const data = sentimentArc.map((entry) => ({
    ...entry,
    score: SENTIMENT_SCORE[entry.sentiment] || 3,
    label: (entry.timestamp || '').replace(/[\[\]]/g, '') || `Turn ${entry.turn ?? ''}`,
  }));

  const trend = data.length >= 2
    ? data[data.length - 1].score > data[0].score ? 'improving'
    : data[data.length - 1].score < data[0].score ? 'deteriorating'
    : 'stable'
    : 'stable';

  const trendConfig = {
    improving: { color: 'text-emerald-700 bg-emerald-50 border-emerald-200', icon: TrendingUp, label: 'Improving' },
    deteriorating: { color: 'text-red-700 bg-red-50 border-red-200', icon: TrendingDown, label: 'Deteriorating' },
    stable: { color: 'text-slate-500 bg-slate-50 border-slate-200', icon: Minus, label: 'Stable' },
  };
  const tc = trendConfig[trend];
  const TrendIcon = tc.icon;

  const escalationCount = data.filter((d) => d.escalation_trigger).length;

  return (
    <div className="glass rounded-3xl p-6 space-y-5 fade-up">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h3 className="text-base font-semibold flex items-center gap-2 text-slate-800">
          <Activity className="w-4 h-4 text-brand-500" />
          Customer Sentiment Arc
        </h3>
        <div className="flex items-center gap-2">
          <span className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold border ${tc.color}`}>
            <TrendIcon className="w-3 h-3" />
            {tc.label}
          </span>
          {escalationCount > 0 && (
            <span className="px-2.5 py-1 bg-red-50 border border-red-200 text-red-700 rounded-lg text-xs font-semibold">
              {escalationCount} escalation{escalationCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <AreaChart data={data} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
          <defs>
            <linearGradient id="sentimentGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-brand-500)" stopOpacity={0.25} />
              <stop offset="100%" stopColor="var(--color-brand-500)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="2 4" stroke="var(--color-surface-3)" />
          <XAxis dataKey="label" tick={{ fill: 'oklch(0.45 0.01 220)', fontSize: 10 }} tickLine={false} axisLine={{ stroke: 'var(--color-surface-3)' }} />
          <YAxis
            domain={[1, 4]}
            ticks={[1, 2, 3, 4]}
            tickFormatter={(v) => SENTIMENT_LABELS[v] || ''}
            tick={{ fill: 'oklch(0.45 0.01 220)', fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            width={70}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ stroke: 'var(--color-brand-500)', strokeOpacity: 0.3 }} />
          <ReferenceLine y={2.5} stroke="var(--color-surface-4)" strokeDasharray="4 4" />
          <Area
            type="monotone"
            dataKey="score"
            stroke="var(--color-brand-500)"
            strokeWidth={2.5}
            fill="url(#sentimentGrad)"
            dot={<CustomDot />}
            activeDot={{ r: 7, stroke: 'var(--color-surface-1)', strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>

      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-2 pt-2 border-t border-slate-200">
        {Object.entries(SENTIMENT_COLOR).map(([s, color]) => (
          <div key={s} className="flex items-center gap-1.5 text-xs text-slate-500 font-medium">
            <div className="w-2.5 h-2.5 rounded-full" style={{ background: color }} />
            <span className="capitalize">{s}</span>
          </div>
        ))}
        <div className="flex items-center gap-1.5 text-xs text-slate-500 font-medium">
          <div className="w-3 h-3 rounded-full border border-red-500/50 border-dashed" />
          <span>Escalation</span>
        </div>
      </div>
    </div>
  );
}
