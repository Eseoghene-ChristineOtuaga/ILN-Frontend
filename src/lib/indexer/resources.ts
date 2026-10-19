/**
 * Allow-list of indexer resources the browser may request through the proxy.
 *
 * Each resource declares its public path, accepted query parameters, the
 * upstream indexer path, and a parser that validates the upstream payload.
 * Anything not listed here is rejected by the proxy before reaching the indexer.
 *
 * Partial-record policy: when the top-level shape is wrong the whole response
 * is a `schema` error. When individual records are malformed they are omitted
 * and counted in `droppedRecords` so the UI can disclose it. If every record is
 * malformed the response is a `schema` error rather than an empty dataset.
 */

import { IndexerError } from './errors';
import type {
  IndexerDefaultBucket,
  IndexerFundingBucket,
  IndexerFundingToken,
  IndexerInvoiceEvent,
  IndexerLeaderboardEntry,
  IndexerResourceDataMap,
  IndexerResourceName,
} from './types';

export interface ParsedRecords<T> {
  records: T[];
  dropped: number;
}

interface QueryParamSpec {
  allowed?: readonly string[];
  pattern?: RegExp;
  default?: string;
}

export interface IndexerResourceDefinition<N extends IndexerResourceName = IndexerResourceName> {
  name: N;
  /** Returns path params when `segments` addresses this resource, otherwise null. */
  match(segments: readonly string[]): Record<string, string> | null;
  query: Record<string, QueryParamSpec>;
  upstreamPath(params: Record<string, string>): string;
  parse(body: unknown): ParsedRecords<IndexerResourceDataMap[N][number]>;
}

// ─── Primitive guards ─────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function toEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Accept seconds or milliseconds; ledgers close times are reported in seconds.
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return toEpochMs(numeric);
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function parseRecords<T>(
  items: unknown,
  parseItem: (item: unknown) => T | null,
  label: string
): ParsedRecords<T> {
  if (!Array.isArray(items)) {
    throw new IndexerError('schema', `Indexer ${label} response is not a list.`);
  }
  const records: T[] = [];
  for (const item of items) {
    const parsed = parseItem(item);
    if (parsed !== null) records.push(parsed);
  }
  const dropped = items.length - records.length;
  if (items.length > 0 && records.length === 0) {
    throw new IndexerError('schema', `Every ${label} record from the indexer was malformed.`);
  }
  return { records, dropped };
}

// ─── Record parsers ───────────────────────────────────────────────────────────

export function parseInvoiceEvent(item: unknown): IndexerInvoiceEvent | null {
  if (!isRecord(item) || !isNonEmptyString(item.type)) return null;
  const timestamp = toEpochMs(item.timestamp);
  if (timestamp === null) return null;
  if (item.actor !== undefined && typeof item.actor !== 'string') return null;
  if (item.data !== undefined && !isRecord(item.data)) return null;

  return {
    type: item.type,
    timestamp,
    ...(item.actor ? { actor: item.actor } : {}),
    ...(item.data ? { data: item.data as Record<string, unknown> } : {}),
  };
}

export function parseDefaultBucket(item: unknown): IndexerDefaultBucket | null {
  if (!isRecord(item)) return null;
  const { date, label, defaulted, funded, defaultRate } = item;
  if (!isNonEmptyString(date) || !isNonEmptyString(label)) return null;
  if (!isFiniteNonNegative(defaulted) || !isFiniteNonNegative(funded)) return null;
  if (!isFiniteNonNegative(defaultRate) || defaultRate > 100) return null;
  if (defaulted > funded) return null;
  return { date, label, defaulted, funded, defaultRate };
}

function parseFundingToken(item: unknown): IndexerFundingToken | null {
  if (!isRecord(item) || !isNonEmptyString(item.symbol) || !isFiniteNonNegative(item.amount)) {
    return null;
  }
  return { symbol: item.symbol, amount: item.amount };
}

export function parseFundingBucket(item: unknown): IndexerFundingBucket | null {
  if (!isRecord(item)) return null;
  const { date, label, total_usdc_equiv, invoices_funded, tokens } = item;
  if (!isNonEmptyString(date) || !isNonEmptyString(label)) return null;
  if (!isFiniteNonNegative(total_usdc_equiv) || !isFiniteNonNegative(invoices_funded)) return null;
  if (!Array.isArray(tokens)) return null;
  const parsedTokens = tokens.map(parseFundingToken);
  if (parsedTokens.some((token) => token === null)) return null;
  return {
    date,
    label,
    total_usdc_equiv,
    invoices_funded,
    tokens: parsedTokens as IndexerFundingToken[],
  };
}

export function parseLeaderboardEntry(item: unknown): IndexerLeaderboardEntry | null {
  if (!isRecord(item)) return null;
  const address = isNonEmptyString(item.address)
    ? item.address
    : isNonEmptyString(item.lp)
      ? item.lp
      : null;
  if (!address) return null;

  const entry: IndexerLeaderboardEntry = { address };
  for (const [key, value] of Object.entries(item)) {
    if (key === 'address' || key === 'lp') continue;
    if (typeof value === 'number' && Number.isFinite(value)) entry[key] = value;
  }
  return entry;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const INVOICE_ID_PATTERN = /^\d{1,20}$/;

function exact(...expected: string[]) {
  return (segments: readonly string[]) =>
    segments.length === expected.length && expected.every((part, i) => segments[i] === part)
      ? {}
      : null;
}

const defaults: IndexerResourceDefinition<'analytics.defaults'> = {
  name: 'analytics.defaults',
  match: exact('analytics', 'defaults'),
  query: { period: { allowed: ['12m'], default: '12m' } },
  upstreamPath: ({ period }) => `/analytics/defaults?period=${period}`,
  parse: (body) =>
    // The indexer has historically returned either `{ monthly: [...] }` or a bare list.
    parseRecords(isRecord(body) ? body.monthly : body, parseDefaultBucket, 'default-rate'),
};

const funding: IndexerResourceDefinition<'analytics.funding'> = {
  name: 'analytics.funding',
  match: exact('analytics', 'funding'),
  query: { period: { allowed: ['7d', '30d', '90d', 'all'], default: '30d' } },
  upstreamPath: ({ period }) => `/v1/analytics/funding?period=${period}`,
  parse: (body) =>
    parseRecords(isRecord(body) ? body.daily : undefined, parseFundingBucket, 'funding'),
};

const invoiceEvents: IndexerResourceDefinition<'invoice.events'> = {
  name: 'invoice.events',
  match: (segments) =>
    segments.length === 3 &&
    segments[0] === 'invoices' &&
    INVOICE_ID_PATTERN.test(segments[1]) &&
    segments[2] === 'events'
      ? { invoiceId: segments[1] }
      : null,
  query: {},
  upstreamPath: ({ invoiceId }) => `/invoice/${invoiceId}/events`,
  parse: (body) => parseRecords(body, parseInvoiceEvent, 'invoice event'),
};

const leaderboard: IndexerResourceDefinition<'leaderboard'> = {
  name: 'leaderboard',
  match: exact('leaderboard'),
  query: {
    type: { allowed: ['lp', 'payer', 'freelancer'], default: 'lp' },
    period: { allowed: ['all', '90d', '30d', '7d'], default: 'all' },
    limit: { pattern: /^(?:[1-9]\d?|100)$/ },
  },
  upstreamPath: ({ type, period, limit }) =>
    `/leaderboard?type=${type}&period=${period}${limit ? `&limit=${limit}` : ''}`,
  parse: (body) => parseRecords(body, parseLeaderboardEntry, 'leaderboard'),
};

export const INDEXER_RESOURCES: readonly IndexerResourceDefinition[] = [
  defaults,
  funding,
  invoiceEvents,
  leaderboard,
] as IndexerResourceDefinition[];

export interface ResolvedIndexerRequest {
  resource: IndexerResourceDefinition;
  upstreamPath: string;
}

/**
 * Resolve a browser request (path segments + query) to an allow-listed upstream
 * request. Throws `unknown_resource` or `bad_request` for anything else.
 */
export function resolveIndexerRequest(
  segments: readonly string[],
  searchParams: URLSearchParams
): ResolvedIndexerRequest {
  for (const resource of INDEXER_RESOURCES) {
    const pathParams = resource.match(segments);
    if (!pathParams) continue;

    for (const key of searchParams.keys()) {
      if (!(key in resource.query)) {
        throw new IndexerError('bad_request', `Unsupported query parameter "${key}".`);
      }
    }

    const params: Record<string, string> = { ...pathParams };
    for (const [key, spec] of Object.entries(resource.query)) {
      const value = searchParams.get(key) ?? spec.default;
      if (value === undefined) continue;
      const valid =
        (spec.allowed ? spec.allowed.includes(value) : true) &&
        (spec.pattern ? spec.pattern.test(value) : true);
      if (!valid) {
        throw new IndexerError('bad_request', `Invalid value for query parameter "${key}".`);
      }
      params[key] = value;
    }

    return { resource, upstreamPath: resource.upstreamPath(params) };
  }

  throw new IndexerError('unknown_resource');
}
