import React from 'react';

interface Props {
  rows?: number;
  className?: string;
}

/**
 * Shimmer skeleton card for loading states.
 * Renders stacked placeholder rows with an animated shimmer effect.
 */
export default function SkeletonCard({ rows = 4, className = '' }: Props) {
  return (
    <div className={`glass rounded-3xl p-6 space-y-4 ${className}`} aria-busy="true" aria-label="Loading…">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div className="h-4 w-32 rounded-lg skeleton" />
        <div className="h-8 w-8 rounded-full skeleton" />
      </div>
      {/* Content rows */}
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="space-y-2">
          <div
            className="h-3 rounded-lg skeleton"
            style={{ width: `${85 - i * 8}%`, animationDelay: `${i * 0.08}s` }}
          />
          {i % 2 === 0 && (
            <div
              className="h-3 rounded-lg skeleton"
              style={{ width: `${60 - i * 5}%`, animationDelay: `${i * 0.08 + 0.04}s` }}
            />
          )}
        </div>
      ))}
    </div>
  );
}
