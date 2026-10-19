/**
 * Unified indexer schemas and convenience readers (#1102–#1105).
 *
 * This module owns the shared indexer types used across the app. Its readers
 * are thin wrappers over the proxy transport in `src/lib/indexer-client.ts`,
 * so every call goes through the same-origin `/api/indexer/*` boundary: the
 * upstream URL and credentials stay on the server (`src/lib/indexer/server.ts`),
 * and payloads are schema-validated and version-checked before they get here.
 */

import {
  fetchDefaultAnalytics,
  fetchFundingAnalytics,
  fetchInvoiceEvents as fetchInvoiceEventsViaProxy,
  fetchLeaderboardEntries,
  type IndexerRequestOptions,
} from '@/lib/indexer-client';

// ─── Types & Schemas ────────────────────────────────────────────────────────────

export interface IndexerError {
  message: string;
  code?: string;
  status?: number;
}

export interface RawInvoiceEvent {
  type?: string;
  timestamp?: number | string;
  actor?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface MonthlyDefaultBucket {
  date: string;
  label: string;
  defaulted: number;
  funded: number;
  defaultRate: number;
}

export interface TokenFunding {
  symbol: string;
  amount: number;
  color: string;
}

export interface DailyFundingBucket {
  date: string;
  label: string;
  total_usdc_equiv: number;
  invoices_funded: number;
  tokens: TokenFunding[];
}

export interface FundingResponse {
  daily: DailyFundingBucket[];
}

export interface DefaultRateResponse {
  monthly: MonthlyDefaultBucket[];
}

export interface LeaderboardEntry {
  address: string;
  score: number;
  rank?: number;
  [key: string]: unknown;
}

/**
 * Query for analytics readers. The proxy allow-list accepts `period` only;
 * time-window filters are not part of the indexer contract.
 */
export interface AnalyticsQuery {
  period?: string;
}

export type { IndexerRequestOptions };

// ─── Public API Methods ─────────────────────────────────────────────────────────

/** Invoice activity events. */
export async function fetchInvoiceEvents(
  invoiceId: bigint | string,
  options?: IndexerRequestOptions
): Promise<RawInvoiceEvent[]> {
  return fetchInvoiceEventsViaProxy(invoiceId, options);
}

/** Monthly default-rate buckets. */
export async function fetchDefaultRateData(
  query: AnalyticsQuery = {},
  options?: IndexerRequestOptions
): Promise<MonthlyDefaultBucket[]> {
  return fetchDefaultAnalytics(query.period ?? '12m', options);
}

/** Daily funding buckets. */
export async function fetchFundingData(
  query: AnalyticsQuery = {},
  options?: IndexerRequestOptions
): Promise<DailyFundingBucket[]> {
  // The proxy returns tokens without display colors; components assign colors.
  return (await fetchFundingAnalytics(query.period ?? '30d', options)) as DailyFundingBucket[];
}

/** Leaderboard rows. `type` is the leaderboard kind (`lp`, `payer`, `freelancer`). */
export async function fetchLeaderboard(
  limit: number = 100,
  type: string = 'lp',
  options?: IndexerRequestOptions
): Promise<LeaderboardEntry[]> {
  return fetchLeaderboardEntries<LeaderboardEntry[]>(type, 'all', limit, options);
}

/**
 * Health check: true when the proxy is configured and the indexer answers a
 * minimal allow-listed request with a compatible, valid response.
 */
export async function checkIndexerHealth(): Promise<boolean> {
  try {
    await fetchLeaderboardEntries('lp', 'all', 1, { retries: 0, timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}
