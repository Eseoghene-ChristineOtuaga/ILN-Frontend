import {
  fetchLeaderboard,
  type LeaderboardResult,
  type IndexerRequestOptions,
} from '@/lib/indexer-client';

export type { LeaderboardResult };

/**
 * Fetch the leaderboard from the indexer service. Returns a discriminated result
 * so callers can distinguish "indexer temporarily unavailable" from "no rows" —
 * the former should surface an honest unavailable state rather than empty data.
 *
 * When INDEXER_API_KEY is set, uses authenticated access for higher rate limits.
 * Server-side only (the API key must never be exposed to the client).
 */
export async function getLeaderboard<T = unknown[]>(
  type: string,
  period: string,
  options?: IndexerRequestOptions
): Promise<LeaderboardResult<T>> {
  const indexerUrl = process.env.INDEXER_URL;
  if (!indexerUrl) {
    return { data: [] as unknown as T, unavailable: false, status: 'empty' };
  }

  return fetchLeaderboard<T>(type, period, options);
}
