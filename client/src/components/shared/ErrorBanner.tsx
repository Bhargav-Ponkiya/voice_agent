import React from 'react';
import { AlertCircle, WifiOff, RefreshCw, X } from 'lucide-react';

interface Props {
  message: string;
  code?: string;
  onRetry?: () => void;
  onDismiss?: () => void;
  className?: string;
}

/**
 * Reusable error banner with icon, message, optional retry, and dismiss.
 * Selects icon based on error code for better at-a-glance recognition.
 */
export default function ErrorBanner({ message, code, onRetry, onDismiss, className = '' }: Props) {
  const isNetworkError = code === 'NETWORK_ERROR';
  const Icon = isNetworkError ? WifiOff : AlertCircle;

  return (
    <div
      role="alert"
      className={`flex items-start gap-3 px-4 py-3.5 rounded-xl bg-red-50 border border-red-200 text-red-800 text-sm shadow-sm ${className}`}
      style={{ animation: 'errorShake 0.35s ease-out' }}
    >
      <Icon className="w-4 h-4 mt-0.5 flex-shrink-0 text-red-500" aria-hidden="true" />
      <p className="flex-1 leading-relaxed font-medium">{message}</p>
      <div className="flex items-center gap-2 flex-shrink-0 ml-2">
        {onRetry && (
          <button
            onClick={onRetry}
            className="flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-lg bg-red-100 hover:bg-red-200 border border-red-200 text-red-700 transition-colors cursor-pointer"
            aria-label="Retry"
          >
            <RefreshCw className="w-3 h-3" />
            Retry
          </button>
        )}
        {onDismiss && (
          <button
            onClick={onDismiss}
            className="p-1 rounded-lg hover:bg-red-100 text-red-400 hover:text-red-600 transition-colors cursor-pointer"
            aria-label="Dismiss error"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}
