'use client';

export type IndexerNoticeStatus = 'unavailable' | 'unauthorized' | 'rate-limited' | 'malformed';

export interface IndexerUnavailableNoticeProps {
  /** The data-source label, e.g. 'activity feed'. */
  dataSource?: string;
  /** Optional retry handler to re-attempt the fetch. */
  onRetry?: () => void;
  retrying?: boolean;
  /** Normalized error reason (#1109). Defaults to 'unavailable'. */
  status?: IndexerNoticeStatus;
  /** Optional extra diagnostic message or detail. */
  detail?: string;
}

const NOTICE_CONFIG: Record<
  IndexerNoticeStatus,
  {
    icon: string;
    title: (source: string) => string;
    description: (source: string) => string;
  }
> = {
  unavailable: {
    icon: 'cloud_off',
    title: (source) => `${source} is temporarily unavailable`,
    description: (source) =>
      `The indexer that powers ${source.toLowerCase()} is unreachable right now. Direct contract reads are unaffected. Please try again shortly.`,
  },
  unauthorized: {
    icon: 'lock',
    title: (source) => `${source} requires authorization`,
    description: (source) =>
      `You are not authorized to view ${source.toLowerCase()}. Connect an authorized wallet or configure indexer credentials.`,
  },
  'rate-limited': {
    icon: 'speed',
    title: (source) => `${source} is temporarily rate-limited`,
    description: (source) =>
      `The indexer rate limit has been reached for ${source.toLowerCase()}. Please wait a moment before trying again.`,
  },
  malformed: {
    icon: 'error',
    title: (source) => `${source} returned an unexpected response`,
    description: (source) =>
      `The indexer response for ${source.toLowerCase()} contained malformed data. Stale or invalid data has been rejected.`,
  },
};

/**
 * Honest fallback shown when an indexer-dependent feature cannot reach the
 * indexer, instead of silently rendering fabricated or empty data. Mirrors the
 * app's ErrorBoundary/retry pattern. See docs/indexer-downtime.md.
 */
export default function IndexerUnavailableNotice({
  dataSource = 'this data',
  onRetry,
  retrying = false,
  status = 'unavailable',
  detail,
}: IndexerUnavailableNoticeProps) {
  const config = NOTICE_CONFIG[status] || NOTICE_CONFIG.unavailable;

  return (
    <div
      role="alert"
      aria-live="assertive"
      data-testid={`indexer-notice-${status}`}
      className="rounded-3xl border border-outline-variant/20 bg-surface-container-lowest p-6 text-center"
    >
      <span
        className="material-symbols-outlined mb-3 block text-3xl text-on-surface-variant/40"
        aria-hidden="true"
      >
        {config.icon}
      </span>
      <p className="font-medium text-on-surface">{config.title(dataSource)}</p>
      <p className="mt-1 text-sm text-on-surface-variant">
        {config.description(dataSource)}
      </p>
      {detail ? <p className="mt-2 text-xs text-on-surface-variant/70">{detail}</p> : null}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-4 rounded-xl bg-primary px-5 py-2.5 text-sm font-bold text-white disabled:opacity-50"
        >
          {retrying ? 'Retrying…' : 'Try again'}
        </button>
      )}
    </div>
  );
}

/** Only substitute demo/mock data for an unavailable indexer in development. */
export function shouldUseDevMockFallback(): boolean {
  return process.env.NODE_ENV === 'development';
}
