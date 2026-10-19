'use client';

import React from 'react';
import type { IndexerBoundaryStatus } from '@/lib/indexer-boundary';

/**
 * Reusable presentational renderer for the indexer boundary states (#1155).
 *
 * Pure and prop-driven so it can be reused by any indexer-backed surface and
 * snapshotted deterministically in Storybook. It never fabricates data and
 * always exposes an accessible role so screen readers announce the boundary.
 */

export interface IndexerBoundaryStateProps {
  status: IndexerBoundaryStatus;
  /** Optional secondary detail (e.g. the last-good timestamp for `stale`). */
  detail?: string;
  /** Renders a retry affordance when provided. */
  onRetry?: () => void;
}

interface BoundaryConfig {
  icon: string;
  title: string;
  message: string;
  role: 'status' | 'alert';
}

const BOUNDARY_CONFIG: Record<IndexerBoundaryStatus, BoundaryConfig> = {
  loading: {
    icon: 'hourglass_top',
    title: 'Loading',
    message: 'Fetching the latest data…',
    role: 'status',
  },
  stale: {
    icon: 'history',
    title: 'Showing stale data',
    message: 'Live data is temporarily unavailable.',
    role: 'status',
  },
  empty: {
    icon: 'inbox',
    title: 'No data yet',
    message: 'There is nothing to show for this view yet.',
    role: 'status',
  },
  unauthorized: {
    icon: 'lock',
    title: 'Not authorized',
    message: 'Connect an authorized wallet to view this data.',
    role: 'alert',
  },
  malformed: {
    icon: 'error',
    title: 'Unexpected response',
    message: 'The data returned could not be understood.',
    role: 'alert',
  },
  unavailable: {
    icon: 'cloud_off',
    title: 'Service unavailable',
    message: 'The indexer is temporarily unreachable. Direct contract reads are unaffected.',
    role: 'alert',
  },
  'rate-limited': {
    icon: 'speed',
    title: 'Too many requests',
    message: 'Request rate limit reached. Please wait a moment before retrying.',
    role: 'alert',
  },
};

export function IndexerBoundaryState({ status, detail, onRetry }: IndexerBoundaryStateProps) {
  const { icon, title, message, role } = BOUNDARY_CONFIG[status];

  return (
    <div
      role={role}
      aria-live={role === 'status' ? 'polite' : 'assertive'}
      data-testid={`indexer-boundary-${status}`}
      className="flex flex-col items-center justify-center gap-2 rounded-xl border border-outline-variant/20 bg-surface-container-low p-6 text-center"
    >
      <span
        className={`material-symbols-outlined text-3xl ${role === 'alert' ? 'text-error' : 'text-on-surface-variant/50'}`}
        aria-hidden="true"
      >
        {icon}
      </span>
      <p className="text-sm font-semibold text-on-surface">{title}</p>
      <p className="text-xs text-on-surface-variant">{message}</p>
      {detail ? <p className="text-[11px] text-on-surface-variant/70">{detail}</p> : null}
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-on-primary transition-colors hover:bg-primary/90"
        >
          Retry
        </button>
      ) : null}
    </div>
  );
}
