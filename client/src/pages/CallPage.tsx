import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import VoiceCallInterface from '../components/call/VoiceCallInterface';
import { Scorecard } from '../types';
import { PhoneCall, BarChart3, Sparkles, CheckCircle2 } from 'lucide-react';

export default function CallPage() {
  const navigate = useNavigate();
  const [callComplete, setCallComplete] = useState(false);
  const [lastCallId, setLastCallId] = useState<string | null>(null);

  const handleCallComplete = (callId: string, _scorecard: Scorecard) => {
    setLastCallId(callId);
    setCallComplete(true);
    // Navigate to dashboard after a brief success moment
    setTimeout(() => {
      navigate(`/dashboard/${callId}`);
    }, 1800);
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* ── Header ── */}
      <header className="border-b border-slate-200 px-6 py-3.5 bg-white/80 backdrop-blur-md sticky top-0 z-20">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="absolute inset-0 bg-brand-500/15 blur-md rounded-xl" />
              <div className="relative w-9 h-9 bg-gradient-to-br from-brand-500 to-brand-600 rounded-xl flex items-center justify-center shadow-sm">
                <PhoneCall className="w-5 h-5 text-white" aria-hidden="true" />
              </div>
            </div>
            <div>
              <h1 className="font-bold text-base leading-none text-gradient">NovaTel</h1>
              <p className="text-[11px] text-slate-500 mt-1.5 tracking-wide">Voice Agent · AI Billing Support</p>
            </div>
          </div>
          <button
            onClick={() => navigate('/dashboard')}
            aria-label="Go to QA Dashboard"
            className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-800 transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-50 border border-slate-200/80 cursor-pointer"
          >
            <BarChart3 className="w-4 h-4" aria-hidden="true" />
            <span className="hidden sm:inline">QA Dashboard</span>
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-8 flex flex-col min-h-0">
        {/* ── Page title ── */}
        <div className="mb-6 flex-shrink-0">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-brand-50 border border-brand-200/60 text-brand-700 text-xs font-semibold mb-3">
            <Sparkles className="w-3 h-3 text-brand-600" aria-hidden="true" />
            Self-healing prompt loop · Live
          </div>
          <h2 className="text-3xl font-bold tracking-tight text-slate-800">
            Talk to <span className="text-gradient">Sarah</span>
          </h2>
          <p className="text-slate-500 mt-2 text-sm leading-relaxed max-w-xl">
            NovaTel's AI billing support agent. Try a billing complaint — duplicate charges, late fees,
            plan cancellation, or ask for a manager. After every call the system analyzes it and the
            agent prompt evolves.
          </p>
        </div>

        {/* ── Main interface ── */}
        <div className="flex-1 min-h-0 flex flex-col">
          <VoiceCallInterface onCallComplete={handleCallComplete} />
        </div>

        {/* ── Call complete success flash ── */}
        {callComplete && lastCallId && (
          <div className="mt-5 flex items-center justify-center gap-3 px-5 py-3.5 glass rounded-2xl flex-shrink-0 fade-up">
            <CheckCircle2
              className="w-5 h-5 text-emerald-500 flex-shrink-0 success-pop"
              aria-hidden="true"
            />
            <div>
              <p className="text-sm font-semibold text-slate-700">Call complete — opening analysis…</p>
              <p className="text-xs text-slate-400 font-mono mt-0.5">#{lastCallId.slice(0, 16)}</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
