'use client';

import React, { useEffect, useState } from 'react';
import {
  evaluateIndexerFreshness,
  formatIndexerAge,
  type IndexerFreshness,
} from '@/lib/indexer/freshness';

/** How often freshness is re-evaluated while a view stays open. */
export const FRESHNESS_TICK_MS = 30_000;

/** Discloses records the indexer sent that failed validation and were omitted. */
export function IndexerPartialNotice({ dropped }: { dropped: number }) {
  if (dropped <= 0) return null;
  return (
    <p role="status" className="text-xs text-on-surface-variant">
      {dropped} record{dropped === 1 ? '' : 's'} from the indexer could not be displayed because
      {dropped === 1 ? ' it was' : ' they were'} malformed.
    </p>
  );
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

const FRESHNESS_STYLES = {
  fresh: 'border-outline-variant/20 text-on-surface-variant',
  stale: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  unknown: 'border-outline-variant/20 text-on-surface-variant',
} as const;

/**
 * Shows the last indexed ledger and when it closed, and flags data older than
 * the configured threshold (or of unknown age) so users do not mistake it for live.
 */
export function IndexerFreshnessBadge({ freshness }: { freshness: IndexerFreshness }) {
  const now = useNow(FRESHNESS_TICK_MS);
  const status = evaluateIndexerFreshness(freshness, now);
  const ledger =
    status.lastIndexedLedger !== null
      ? `ledger #${status.lastIndexedLedger.toLocaleString('en-US')}`
      : null;
  const age = status.ageMs !== null ? formatIndexerAge(status.ageMs) : null;

  let label: string;
  if (status.state === 'unknown') {
    label = ledger ? `Indexed through ${ledger} · freshness unknown` : 'Indexer freshness unknown';
  } else if (status.state === 'stale') {
    label = `Data may be out of date · last indexed ${age}${ledger ? ` (${ledger})` : ''}`;
  } else {
    label = `Indexed through ${ledger ?? 'latest ledger'} · updated ${age}`;
  }

  return (
    <p
      role="status"
      data-freshness={status.state}
      title={
        status.lastIndexedAt !== null ? new Date(status.lastIndexedAt).toISOString() : undefined
      }
      className={`inline-flex items-center gap-1.5 self-start rounded-full border px-2.5 py-1 text-[11px] font-medium ${FRESHNESS_STYLES[status.state]}`}
    >
      <span className="material-symbols-outlined text-[14px]" aria-hidden="true">
        {status.state === 'fresh' ? 'sync' : status.state === 'stale' ? 'history' : 'help'}
      </span>
      {label}
    </p>
  );
}
