/**
 * Indexer freshness metadata.
 *
 * The indexer reports how far it has caught up with the chain using two
 * response headers:
 *   X-Indexer-Last-Ledger      last ledger sequence fully indexed (integer)
 *   X-Indexer-Last-Indexed-At  close time of that ledger (ISO-8601 or epoch s/ms)
 *
 * The proxy forwards them as `meta.freshness`. Missing or malformed headers
 * become `null` (shown to users as "freshness unknown"), never a guessed value.
 * Staleness is evaluated in the browser against the current time so that data
 * served later (e.g. from the PWA cache) is still flagged correctly.
 */

export const INDEXER_LAST_LEDGER_HEADER = 'X-Indexer-Last-Ledger';
export const INDEXER_LAST_INDEXED_AT_HEADER = 'X-Indexer-Last-Indexed-At';

export const DEFAULT_INDEXER_STALE_AFTER_MS = 5 * 60_000;
const MIN_STALE_AFTER_MS = 30_000;
const MAX_STALE_AFTER_MS = 24 * 60 * 60_000;
/** Timestamps further than this in the future are treated as malformed. */
const MAX_CLOCK_SKEW_MS = 5 * 60_000;

export interface IndexerFreshness {
  lastIndexedLedger: number | null;
  /** ISO-8601 UTC timestamp. */
  lastIndexedAt: string | null;
  staleAfterMs: number;
}

export type IndexerFreshnessState = 'fresh' | 'stale' | 'unknown';

export interface IndexerFreshnessStatus {
  state: IndexerFreshnessState;
  lastIndexedLedger: number | null;
  lastIndexedAt: number | null;
  ageMs: number | null;
}

export function parseStaleAfterMs(rawSeconds: string | undefined): number {
  if (!rawSeconds) return DEFAULT_INDEXER_STALE_AFTER_MS;
  const seconds = Number(rawSeconds);
  if (!Number.isFinite(seconds)) return DEFAULT_INDEXER_STALE_AFTER_MS;
  return Math.min(MAX_STALE_AFTER_MS, Math.max(MIN_STALE_AFTER_MS, Math.round(seconds * 1000)));
}

function parseLedger(raw: string | null): number | null {
  if (!raw || !/^\d{1,12}$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function parseIndexedAt(raw: string | null, now: number): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let ms: number;
  if (/^\d{9,13}$/.test(value)) {
    const numeric = Number(value);
    ms = numeric < 1e12 ? numeric * 1000 : numeric;
  } else {
    ms = Date.parse(value);
  }
  if (!Number.isFinite(ms) || ms <= 0 || ms > now + MAX_CLOCK_SKEW_MS) return null;
  return new Date(ms).toISOString();
}

/** Server side: read freshness headers from an indexer response. */
export function readIndexerFreshness(
  headers: Headers,
  staleAfterMs: number,
  now: number = Date.now()
): IndexerFreshness {
  return {
    lastIndexedLedger: parseLedger(headers.get(INDEXER_LAST_LEDGER_HEADER)),
    lastIndexedAt: parseIndexedAt(headers.get(INDEXER_LAST_INDEXED_AT_HEADER), now),
    staleAfterMs,
  };
}

/** Browser side: validate the freshness block of an envelope. */
export function isIndexerFreshness(value: unknown): value is IndexerFreshness {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const ledgerOk =
    v.lastIndexedLedger === null ||
    (typeof v.lastIndexedLedger === 'number' && Number.isSafeInteger(v.lastIndexedLedger));
  const atOk =
    v.lastIndexedAt === null ||
    (typeof v.lastIndexedAt === 'string' && !Number.isNaN(Date.parse(v.lastIndexedAt)));
  const staleOk =
    typeof v.staleAfterMs === 'number' && Number.isFinite(v.staleAfterMs) && v.staleAfterMs > 0;
  return ledgerOk && atOk && staleOk;
}

/** Evaluate freshness at `now`. Without a timestamp the state is `unknown`. */
export function evaluateIndexerFreshness(
  freshness: IndexerFreshness,
  now: number = Date.now()
): IndexerFreshnessStatus {
  const lastIndexedAt = freshness.lastIndexedAt ? Date.parse(freshness.lastIndexedAt) : null;
  if (lastIndexedAt === null || Number.isNaN(lastIndexedAt)) {
    return {
      state: 'unknown',
      lastIndexedLedger: freshness.lastIndexedLedger,
      lastIndexedAt: null,
      ageMs: null,
    };
  }
  const ageMs = Math.max(0, now - lastIndexedAt);
  return {
    state: ageMs > freshness.staleAfterMs ? 'stale' : 'fresh',
    lastIndexedLedger: freshness.lastIndexedLedger,
    lastIndexedAt,
    ageMs,
  };
}

export function formatIndexerAge(ageMs: number): string {
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}
