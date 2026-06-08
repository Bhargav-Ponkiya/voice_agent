import React, { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import QAScorecard from '../components/dashboard/QAScorecard';
import SentimentChart from '../components/dashboard/SentimentChart';
import CallFlowTimeline from '../components/dashboard/CallFlowTimeline';
import TranscriptAnnotated from '../components/dashboard/TranscriptAnnotated';
import CallComparison from '../components/dashboard/CallComparison';
import PromptVersionHistory from '../components/dashboard/PromptVersionHistory';
import ErrorBanner from '../components/shared/ErrorBanner';
import SkeletonCard from '../components/shared/SkeletonCard';
import {
  getAnalysis, getAllAnalyses, getTranscript, getPromptVersions, isApiError,
} from '../services/api';
import { Scorecard, TranscriptTurn, PromptVersion } from '../types';
import { PhoneCall, BarChart3, RefreshCw, Clock, Award } from 'lucide-react';
import { clsx } from 'clsx';

export default function DashboardPage() {
  const { callId } = useParams<{ callId?: string }>();
  const navigate = useNavigate();

  const [scorecard, setScorecard] = useState<Scorecard | null>(null);
  const [transcript, setTranscript] = useState<TranscriptTurn[]>([]);
  const [allAnalyses, setAllAnalyses] = useState<Scorecard[]>([]);
  const [promptVersions, setPromptVersions] = useState<PromptVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const load = useCallback(async (showRefreshSpinner = false) => {
    if (showRefreshSpinner) setIsRefreshing(true);
    else setLoading(true);
    setError(null);

    try {
      const [analyses, versions] = await Promise.all([
        getAllAnalyses(),
        getPromptVersions(),
      ]);
      setAllAnalyses(analyses);
      setPromptVersions(versions);

      const targetId = callId || analyses[0]?.callId;
      if (targetId) {
        const sc = await getAnalysis(targetId);
        setScorecard(sc);

        // Transcript fetch is best-effort — don't fail if missing
        try {
          const txRes = await getTranscript(targetId);
          setTranscript(txRes.turns || []);
        } catch {
          setTranscript([]);
        }
      } else {
        setScorecard(null);
        setTranscript([]);
      }
    } catch (err: unknown) {
      if (isApiError(err)) {
        setError({ message: err.message, code: err.code });
      } else {
        setError({ message: 'Failed to load dashboard data — please try again.' });
      }
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [callId]);

  useEffect(() => {
    load();
  }, [load]);

  // Self-healing patches are generated AFTER analysis:complete (separate Gemini call,
  // ~3–5s of additional work). If the user navigated here right after a call ended,
  // v(n+1) may not be in the DB yet. Poll /api/prompts for a short window so the new
  // version appears live without requiring a manual refresh click.
  useEffect(() => {
    if (loading) return;
    const startCount = promptVersions.length;
    const POLL_INTERVAL_MS = 3000;
    const POLL_DURATION_MS = 20000;
    let elapsed = 0;
    const interval = setInterval(async () => {
      elapsed += POLL_INTERVAL_MS;
      try {
        const versions = await getPromptVersions();
        if (versions.length > startCount) {
          setPromptVersions(versions);
          clearInterval(interval);
          return;
        }
      } catch {
        // Ignore transient errors; keep polling until window expires.
      }
      if (elapsed >= POLL_DURATION_MS) clearInterval(interval);
    }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  // Run once per initial load. Re-running on every promptVersions change would loop forever.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  const currentCallId = callId || allAnalyses[0]?.callId;

  // ─── Skeleton Loading State ─────────────────────────────────────────────
  if (loading) {
    return (
      <div className="min-h-screen flex flex-col">
        <DashboardHeader currentCallId={null} isRefreshing={false} onRefresh={() => {}} />
        <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 space-y-6">
              <SkeletonCard rows={5} />
              <SkeletonCard rows={3} />
            </div>
            <div className="lg:col-span-2 space-y-6">
              <SkeletonCard rows={4} />
              <SkeletonCard rows={6} />
            </div>
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col">
      <DashboardHeader
        currentCallId={currentCallId}
        isRefreshing={isRefreshing}
        onRefresh={() => load(true)}
      />

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6 space-y-6">
        {/* Error State */}
        {error && (
          <ErrorBanner
            message={error.message}
            code={error.code}
            onRetry={() => load(true)}
            onDismiss={() => setError(null)}
          />
        )}

        {/* Call Selector — only when multiple calls exist */}
        {allAnalyses.length > 1 && (
          <CallSelector
            analyses={allAnalyses}
            currentCallId={currentCallId}
            onSelect={(id) => navigate(`/dashboard/${id}`)}
          />
        )}

        {/* Empty State */}
        {!scorecard && !loading && (
          <EmptyState />
        )}

        {/* Main Dashboard Grid */}
        {scorecard && (
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            <div className="lg:col-span-1 space-y-6">
              <QAScorecard scorecard={scorecard} />
              <CallComparison analyses={allAnalyses} />
            </div>

            <div className="lg:col-span-2 space-y-6">
              <SentimentChart sentimentArc={scorecard.sentiment_arc} />
              <CallFlowTimeline callFlow={scorecard.call_flow} />
              {transcript.length > 0 && (
                <TranscriptAnnotated turns={transcript} scorecard={scorecard} />
              )}
            </div>
          </div>
        )}

        {promptVersions.length > 0 && <PromptVersionHistory versions={promptVersions} />}
      </main>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function DashboardHeader({
  currentCallId,
  isRefreshing,
  onRefresh,
}: {
  currentCallId: string | null | undefined;
  isRefreshing: boolean;
  onRefresh: () => void;
}) {
  return (
    <header className="border-b border-slate-200 px-6 py-3.5 sticky top-0 z-20 backdrop-blur-md bg-white/80">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="relative">
            <div className="absolute inset-0 bg-brand-500/15 blur-md rounded-xl" />
            <div className="relative w-9 h-9 bg-gradient-to-br from-brand-400 to-brand-600 rounded-xl flex items-center justify-center shadow-sm">
              <BarChart3 className="w-5 h-5 text-white" aria-hidden="true" />
            </div>
          </div>
          <div>
            <h1 className="font-bold text-base leading-none text-gradient">QA Dashboard</h1>
            {currentCallId && (
              <p className="text-[11px] text-slate-400 mt-1.5 font-mono">
                #{currentCallId.slice(0, 12)}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label="Refresh dashboard"
            className="flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800 disabled:opacity-50 transition-colors px-3 py-1.5 rounded-lg hover:bg-slate-50 border border-slate-200/80 cursor-pointer disabled:cursor-not-allowed"
          >
            <RefreshCw className={clsx('w-4 h-4', isRefreshing && 'animate-spin')} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          <Link
            to="/"
            className="flex items-center gap-1.5 text-sm bg-gradient-to-br from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-700 text-white transition-colors px-3 py-1.5 rounded-lg shadow-sm font-medium cursor-pointer"
          >
            <PhoneCall className="w-4 h-4" aria-hidden="true" />
            <span className="hidden sm:inline">New Call</span>
          </Link>
        </div>
      </div>
    </header>
  );
}

function CallSelector({
  analyses,
  currentCallId,
  onSelect,
}: {
  analyses: Scorecard[];
  currentCallId: string | undefined;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="glass rounded-2xl p-4 fade-up">
      <div className="flex items-center gap-2 mb-3">
        <Clock className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
        <p className="text-[10px] text-slate-400 uppercase tracking-widest font-semibold">
          Recent calls — {analyses.length} total
        </p>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label="Select a call to view">
        {analyses.map((a) => {
          const id = a.callId;
          const isActive = id === currentCallId;
          const scoreColor =
            a.rubric_score >= 80 ? 'text-emerald-600' :
            a.rubric_score >= 60 ? 'text-amber-600' :
            'text-red-600';
          const grade =
            a.rubric_score >= 90 ? 'A' :
            a.rubric_score >= 80 ? 'B' :
            a.rubric_score >= 60 ? 'C' : 'F';

          return (
            <button
              key={id}
              onClick={() => onSelect(id)}
              title={`Call ID: ${id} · Score: ${a.rubric_score}/100`}
              aria-pressed={isActive}
              className={clsx(
                'px-3 py-1.5 rounded-lg text-xs font-mono transition-all border cursor-pointer',
                isActive
                  ? 'bg-brand-50 text-brand-700 border-brand-300 font-semibold shadow-xs'
                  : 'bg-slate-50 text-slate-500 hover:text-slate-800 border-slate-200 hover:border-slate-300 hover:bg-white'
              )}
            >
              #{id.slice(0, 8)}
              <span className={clsx('ml-2 font-bold', scoreColor)}>
                {a.rubric_score}
              </span>
              <span className={clsx(
                'ml-1 text-[9px] font-bold px-1 py-0.5 rounded',
                a.rubric_score >= 80 ? 'bg-emerald-100 text-emerald-700' :
                a.rubric_score >= 60 ? 'bg-amber-100 text-amber-700' :
                'bg-red-100 text-red-700'
              )}>
                {grade}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="glass rounded-3xl p-12 text-center fade-up">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-50 to-brand-100 mx-auto mb-5 flex items-center justify-center border border-brand-200 shadow-sm">
        <Award className="w-8 h-8 text-brand-400" aria-hidden="true" />
      </div>
      <h2 className="text-xl font-semibold text-slate-700">No calls analyzed yet</h2>
      <p className="text-slate-500 mt-2 mb-7 text-sm max-w-sm mx-auto leading-relaxed">
        Complete a voice call with Sarah and the AI will automatically generate a full QA scorecard here.
      </p>
      <Link
        to="/"
        className="btn-shine inline-flex items-center gap-2 bg-gradient-to-br from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-700 text-white px-6 py-2.5 rounded-xl font-medium transition-all shadow-sm"
      >
        <PhoneCall className="w-4 h-4" aria-hidden="true" />
        Start your first call
      </Link>
    </div>
  );
}
