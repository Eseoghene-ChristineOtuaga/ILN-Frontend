/**
 * Typed classification of indexer boundary outcomes (#1155).
 *
 * Call sites that read from the indexer can use these helpers to map an HTTP
 * status or a parsed payload onto one of the reusable boundary states
 * (loading / stale / empty / unauthorized / malformed) instead of silently
 * falling back to fabricated data.
 */

/** The reusable boundary states every indexer-backed surface can render. */
export type IndexerBoundaryStatus =
  | 'loading'
  | 'stale'
  | 'empty'
  | 'unauthorized'
  | 'malformed'
  | 'unavailable'
  | 'rate-limited';

/** Maps an HTTP status code onto a boundary status, or `null` when it is healthy. */
export function classifyIndexerHttpStatus(status: number): IndexerBoundaryStatus | null {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate-limited';
  if (status === 500 || status === 502 || status === 503 || status === 504) return 'unavailable';
  if (status === 400 || status === 422) return 'malformed';
  return null;
}

/** Classifies a thrown fetch/network error onto a boundary status. */
export function classifyIndexerError(error: unknown): IndexerBoundaryStatus {
  if (error && typeof error === 'object') {
    if ('boundaryStatus' in error && typeof (error as any).boundaryStatus === 'string') {
      return (error as any).boundaryStatus as IndexerBoundaryStatus;
    }
    if ('status' in error && typeof (error as any).status === 'number') {
      const mapped = classifyIndexerHttpStatus((error as any).status);
      if (mapped) return mapped;
    }
  }
  // Network failures leave us without trustworthy data; surface the malformed
  // (unusable) state rather than rendering empty as if it were authoritative.
  return 'malformed';
}

/**
 * Classifies a successfully-parsed indexer payload.
 * - empty array      → `empty`
 * - non-array payload → `malformed`
 * - non-empty array   → `null` (healthy data, render it)
 */
export function classifyIndexerPayload(payload: unknown): IndexerBoundaryStatus | null {
  if (!Array.isArray(payload)) return 'malformed';
  return payload.length === 0 ? 'empty' : null;
}
