/**
 * Wire types for the indexer boundary.
 *
 * The browser only ever talks to `/api/indexer/*` (see `src/lib/indexer-client.ts`), which
 * responds with one of the envelopes below. Data inside a success envelope has
 * already been validated server-side by the resource parsers in `resources.ts`.
 */

import type { IndexerErrorCode } from './errors';
import type { IndexerFreshness } from './freshness';

export type IndexerResourceName =
  | 'analytics.defaults'
  | 'analytics.funding'
  | 'invoice.events'
  | 'leaderboard';

export interface IndexerInvoiceEvent {
  type: string;
  /** Unix epoch milliseconds. */
  timestamp: number;
  actor?: string;
  data?: Record<string, unknown>;
}

export interface IndexerDefaultBucket {
  date: string;
  label: string;
  defaulted: number;
  funded: number;
  defaultRate: number;
}

export interface IndexerFundingToken {
  symbol: string;
  amount: number;
}

export interface IndexerFundingBucket {
  date: string;
  label: string;
  total_usdc_equiv: number;
  invoices_funded: number;
  tokens: IndexerFundingToken[];
}

/** Leaderboard rows keep their address plus every numeric metric the indexer sent. */
export interface IndexerLeaderboardEntry {
  address: string;
  [metric: string]: string | number;
}

export interface IndexerResourceDataMap {
  'analytics.defaults': IndexerDefaultBucket[];
  'analytics.funding': IndexerFundingBucket[];
  'invoice.events': IndexerInvoiceEvent[];
  leaderboard: IndexerLeaderboardEntry[];
}

export interface IndexerResponseMeta {
  /** Indexer API version negotiated by the proxy, or `unknown` under `allow-missing`. */
  apiVersion: string;
  /** Records the indexer sent that failed validation and were omitted. */
  droppedRecords: number;
  /** How far the indexer had caught up with the chain when it answered. */
  freshness: IndexerFreshness;
}

export interface IndexerSuccessEnvelope<T> {
  ok: true;
  resource: IndexerResourceName;
  data: T;
  meta: IndexerResponseMeta;
}

export interface IndexerErrorEnvelope {
  ok: false;
  error: {
    code: IndexerErrorCode;
    message: string;
  };
}

export type IndexerEnvelope<T> = IndexerSuccessEnvelope<T> | IndexerErrorEnvelope;
