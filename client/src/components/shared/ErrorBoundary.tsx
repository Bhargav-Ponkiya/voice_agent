import React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface State {
  hasError: boolean;
  error: Error | null;
}

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

/**
 * Catches render-time errors in any descendant component and shows a fallback
 * instead of a blank white screen. Critical for the dashboard, where any single
 * malformed scorecard field would otherwise take down the whole page.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // Surface to console so we can see it during local testing + in browser devtools post-deploy.
    console.error('[ErrorBoundary]', error, info);
  }

  reset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <div className="min-h-[400px] flex items-center justify-center px-4">
        <div className="glass rounded-3xl p-10 text-center max-w-md w-full">
          <div className="w-14 h-14 rounded-2xl bg-red-50 border border-red-200 flex items-center justify-center mx-auto mb-5">
            <AlertTriangle className="w-7 h-7 text-red-500" aria-hidden="true" />
          </div>
          <h2 className="text-xl font-bold text-slate-800">Something went wrong</h2>
          <p className="text-slate-500 mt-2 mb-2 text-sm leading-relaxed">
            A rendering error occurred. The rest of the app is still working.
          </p>
          {this.state.error?.message && (
            <p className="text-xs text-slate-400 font-mono bg-slate-50 rounded-lg px-3 py-2 mb-5 overflow-auto">
              {this.state.error.message}
            </p>
          )}
          <button
            onClick={this.reset}
            className="inline-flex items-center gap-2 bg-gradient-to-br from-brand-500 to-brand-600 hover:from-brand-600 hover:to-brand-700 text-white px-5 py-2.5 rounded-xl font-medium transition-all shadow-sm cursor-pointer"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            Try again
          </button>
        </div>
      </div>
    );
  }
}
