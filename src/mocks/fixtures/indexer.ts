/**
 * Indexer boundary fixtures (#1113).
 *
 * Shared catalogue of valid payloads, malformed payloads, partial records,
 * upstream failures (auth, timeout, rate limit, drift) and freshness headers.
 * Used by unit tests (resource parsers), integration tests (route handler over
 * MSW) and component tests (browser envelopes). Test-only: nothing in the
 * production path imports this file.
 */

import { delay, http, HttpResponse } from 'msw';
import type { IndexerErrorCode } from '@/lib/indexer/errors';
import type { IndexerFreshness } from '@/lib/indexer/freshness';
import type { IndexerResourceName } from '@/lib/indexer/types';

export const INDEXER_FIXTURE_URL = 'https://indexer.fixture.test';
export const INDEXER_FIXTURE_KEY = 'fixture_indexer_key_must_not_leak';
/** Fixed reference time so freshness fixtures are deterministic. */
export const INDEXER_FIXTURE_NOW = Date.parse('2026-10-16T12:00:00Z');

const ACTOR = 'GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H';

// ─── Request addressing ───────────────────────────────────────────────────────

/** Browser-facing path (relative to /api/indexer) for each resource. */
export const INDEXER_PROXY_PATHS: Record<IndexerResourceName, string> = {
  'analytics.defaults': 'analytics/defaults?period=12m',
  'analytics.funding': 'analytics/funding?period=30d',
  'invoice.events': 'invoices/7/events',
  leaderboard: 'leaderboard?type=lp&period=all',
};

/** Upstream indexer path the proxy calls for each resource. */
export const INDEXER_UPSTREAM_PATHS: Record<IndexerResourceName, string> = {
  'analytics.defaults': '/analytics/defaults',
  'analytics.funding': '/v1/analytics/funding',
  'invoice.events': '/invoice/7/events',
  leaderboard: '/leaderboard',
};

export const INDEXER_RESOURCE_NAMES = Object.keys(INDEXER_PROXY_PATHS) as IndexerResourceName[];

// ─── Headers ──────────────────────────────────────────────────────────────────

function iso(ms: number) {
  return new Date(ms).toISOString();
}

export const indexerHeaderFixtures = {
  current: {
    'X-Indexer-Api-Version': '1.3.0',
    'X-Indexer-Last-Ledger': '51234567',
    'X-Indexer-Last-Indexed-At': iso(INDEXER_FIXTURE_NOW - 20_000),
  },
  stale: {
    'X-Indexer-Api-Version': '1.3.0',
    'X-Indexer-Last-Ledger': '51200000',
    'X-Indexer-Last-Indexed-At': iso(INDEXER_FIXTURE_NOW - 6 * 3_600_000),
  },
  malformedFreshness: {
    'X-Indexer-Api-Version': '1.3.0',
    'X-Indexer-Last-Ledger': 'latest',
    'X-Indexer-Last-Indexed-At': 'a while ago',
  },
  missingVersion: {
    'X-Indexer-Last-Ledger': '51234567',
  },
  futureMajor: {
    'X-Indexer-Api-Version': '2.0.0',
  },
  garbageVersion: {
    'X-Indexer-Api-Version': 'v-next',
  },
} satisfies Record<string, Record<string, string>>;

// ─── Payloads ─────────────────────────────────────────────────────────────────

export const validIndexerPayloads: Record<IndexerResourceName, unknown> = {
  'analytics.defaults': {
    monthly: [
      { date: '2026-08', label: 'Aug 2026', defaulted: 1, funded: 20, defaultRate: 5 },
      { date: '2026-09', label: 'Sep 2026', defaulted: 2, funded: 25, defaultRate: 8 },
    ],
  },
  'analytics.funding': {
    daily: [
      {
        date: '2026-10-15',
        label: 'Oct 15',
        total_usdc_equiv: 1500,
        invoices_funded: 2,
        tokens: [
          { symbol: 'USDC', amount: 1000 },
          { symbol: 'EURC', amount: 463 },
        ],
      },
    ],
  },
  'invoice.events': [
    { type: 'invoice_submitted', timestamp: 1_760_000_000, actor: ACTOR },
    { type: 'funded', timestamp: '2026-10-01T10:00:00Z', actor: ACTOR, data: { amount: '1000' } },
  ],
  leaderboard: [
    { address: ACTOR, metric1: 12, metric2: 4.5 },
    { lp: 'GCFXHS4GXL6BVUCXBWXGTITROWLVYXQKQLF4YH5O5JT3YZXCYPAFBJZB', totalFunded: 9000 },
  ],
};

export type MalformedExpectation =
  | { kind: 'schema' }
  | { kind: 'partial'; kept: number; dropped: number };

export interface MalformedPayloadFixture {
  name: string;
  resource: IndexerResourceName;
  body: unknown;
  expect: MalformedExpectation;
}

const schema = { kind: 'schema' } as const;
const partial = (kept: number, dropped: number) => ({ kind: 'partial', kept, dropped }) as const;

const validEvent = { type: 'paid', timestamp: 1_760_000_000 };
const validDefault = {
  date: '2026-09',
  label: 'Sep 2026',
  defaulted: 1,
  funded: 10,
  defaultRate: 10,
};
const validFunding = {
  date: '2026-10-15',
  label: 'Oct 15',
  total_usdc_equiv: 10,
  invoices_funded: 1,
  tokens: [{ symbol: 'USDC', amount: 10 }],
};

export const malformedIndexerPayloads: MalformedPayloadFixture[] = [
  // invoice.events
  {
    name: 'events: object instead of list',
    resource: 'invoice.events',
    body: { events: [] },
    expect: schema,
  },
  { name: 'events: null body', resource: 'invoice.events', body: null, expect: schema },
  { name: 'events: string body', resource: 'invoice.events', body: 'ok', expect: schema },
  {
    name: 'events: every record malformed',
    resource: 'invoice.events',
    body: [{}, { type: 5, timestamp: 1 }, null, 'event'],
    expect: schema,
  },
  {
    name: 'events: partial records',
    resource: 'invoice.events',
    body: [
      validEvent,
      { type: 'funded' }, // missing timestamp
      { type: 'paid', timestamp: 'not-a-date' },
      { type: 'paid', timestamp: -5 },
      { type: '   ', timestamp: 1 },
      { type: 'paid', timestamp: 1, actor: 42 },
      { type: 'paid', timestamp: 1, data: 'amount=5' },
      { ...validEvent, actor: ACTOR },
    ],
    expect: partial(2, 6),
  },
  { name: 'events: empty list', resource: 'invoice.events', body: [], expect: partial(0, 0) },

  // analytics.defaults
  {
    name: 'defaults: monthly is a string',
    resource: 'analytics.defaults',
    body: { monthly: 'n/a' },
    expect: schema,
  },
  { name: 'defaults: number body', resource: 'analytics.defaults', body: 42, expect: schema },
  {
    name: 'defaults: partial records',
    resource: 'analytics.defaults',
    body: {
      monthly: [
        validDefault,
        { ...validDefault, defaultRate: 150 },
        { ...validDefault, defaulted: 11 }, // defaulted > funded
        { ...validDefault, funded: -1 },
        { ...validDefault, funded: '10' },
        { ...validDefault, label: '' },
        { ...validDefault, defaultRate: null },
      ],
    },
    expect: partial(1, 6),
  },
  {
    name: 'defaults: bare list accepted',
    resource: 'analytics.defaults',
    body: [validDefault],
    expect: partial(1, 0),
  },

  // analytics.funding
  {
    name: 'funding: bare list without daily',
    resource: 'analytics.funding',
    body: [validFunding],
    expect: schema,
  },
  {
    name: 'funding: daily is null',
    resource: 'analytics.funding',
    body: { daily: null },
    expect: schema,
  },
  {
    name: 'funding: partial records',
    resource: 'analytics.funding',
    body: {
      daily: [
        validFunding,
        { ...validFunding, tokens: 'USDC' },
        { ...validFunding, tokens: [{ symbol: 'USDC', amount: -1 }] },
        { ...validFunding, tokens: [{ amount: 5 }] },
        { ...validFunding, total_usdc_equiv: '10' },
        { ...validFunding, invoices_funded: Number.NaN },
      ],
    },
    expect: partial(1, 5),
  },

  // leaderboard
  {
    name: 'leaderboard: wrapped in data',
    resource: 'leaderboard',
    body: { data: [] },
    expect: schema,
  },
  {
    name: 'leaderboard: partial records',
    resource: 'leaderboard',
    body: [
      { address: ACTOR, metric1: 1 },
      { metric1: 4 }, // no address
      { address: '', metric1: 2 },
      { address: 7, metric1: 2 },
      { lp: ACTOR, metric1: 3 },
    ],
    expect: partial(2, 3),
  },
];

// ─── Upstream failures ────────────────────────────────────────────────────────

export interface UpstreamFailureFixture {
  name: string;
  /** Builds the upstream response; `hang` never responds (exercises the timeout). */
  respond: 'hang' | (() => Response);
  expectedCode: IndexerErrorCode;
  expectedStatus: number;
}

function upstream(status: number, body: string, headers: Record<string, string> = {}) {
  return () =>
    new HttpResponse(body, {
      status,
      headers: { 'Content-Type': 'application/json', ...headers },
    });
}

/** Upstream bodies echo the key/URL to prove the proxy never forwards them. */
const LEAKY_BODY = JSON.stringify({
  error: `invalid key ${INDEXER_FIXTURE_KEY} for ${INDEXER_FIXTURE_URL}`,
});

export const indexerUpstreamFailures: UpstreamFailureFixture[] = [
  {
    name: '401 rejected credential',
    respond: upstream(401, LEAKY_BODY),
    expectedCode: 'unauthorized',
    expectedStatus: 502,
  },
  {
    name: '403 forbidden resource',
    respond: upstream(403, LEAKY_BODY),
    expectedCode: 'forbidden',
    expectedStatus: 502,
  },
  {
    name: '404 unknown record',
    respond: upstream(404, '{}'),
    expectedCode: 'not_found',
    expectedStatus: 404,
  },
  {
    name: '429 rate limited',
    respond: upstream(429, '{}'),
    expectedCode: 'rate_limited',
    expectedStatus: 429,
  },
  {
    name: '500 server error',
    respond: upstream(500, LEAKY_BODY),
    expectedCode: 'upstream',
    expectedStatus: 502,
  },
  {
    name: '504 gateway timeout',
    respond: upstream(504, ''),
    expectedCode: 'timeout',
    expectedStatus: 504,
  },
  { name: 'hung upstream', respond: 'hang', expectedCode: 'timeout', expectedStatus: 504 },
  {
    name: 'HTML error page with 200',
    respond: upstream(200, '<html><body>Bad gateway</body></html>', indexerHeaderFixtures.current),
    expectedCode: 'schema',
    expectedStatus: 502,
  },
  {
    name: 'truncated JSON',
    respond: upstream(200, '[{"type":"paid","timest', indexerHeaderFixtures.current),
    expectedCode: 'schema',
    expectedStatus: 502,
  },
  {
    name: 'missing API version',
    respond: upstream(200, '[]', indexerHeaderFixtures.missingVersion),
    expectedCode: 'version_mismatch',
    expectedStatus: 502,
  },
  {
    name: 'future major API version',
    respond: upstream(200, '[]', indexerHeaderFixtures.futureMajor),
    expectedCode: 'version_mismatch',
    expectedStatus: 502,
  },
  {
    name: 'unparseable API version',
    respond: upstream(200, '[]', indexerHeaderFixtures.garbageVersion),
    expectedCode: 'version_mismatch',
    expectedStatus: 502,
  },
];

// ─── MSW helpers ──────────────────────────────────────────────────────────────

export interface CapturedUpstreamRequest {
  url: string;
  authorization: string | null;
  acceptVersion: string | null;
}

/**
 * MSW handler for the fixture indexer. `respond` may be a body (sent as JSON
 * with `headers`) or a failure fixture. Captured requests are pushed to `log`.
 */
export function indexerUpstreamHandler(
  resource: IndexerResourceName,
  respond: { body: unknown; headers?: Record<string, string> } | UpstreamFailureFixture,
  log: CapturedUpstreamRequest[] = []
) {
  return http.get(
    `${INDEXER_FIXTURE_URL}${INDEXER_UPSTREAM_PATHS[resource]}`,
    async ({ request }) => {
      log.push({
        url: request.url,
        authorization: request.headers.get('authorization'),
        acceptVersion: request.headers.get('accept-version'),
      });
      if ('expectedCode' in respond) {
        if (respond.respond === 'hang') {
          await delay('infinite');
          return new HttpResponse(null, { status: 204 });
        }
        return respond.respond();
      }
      return HttpResponse.json(respond.body as Parameters<typeof HttpResponse.json>[0], {
        headers: respond.headers ?? indexerHeaderFixtures.current,
      });
    }
  );
}

/** Server env pointing the proxy at the fixture indexer. */
export const indexerFixtureEnv = {
  INDEXER_URL: INDEXER_FIXTURE_URL,
  INDEXER_API_KEY: INDEXER_FIXTURE_KEY,
  INDEXER_TIMEOUT_MS: '1000',
} as const;

// ─── Browser envelopes ────────────────────────────────────────────────────────

export const freshnessFixtures: Record<'fresh' | 'stale' | 'unknown', IndexerFreshness> = {
  fresh: {
    lastIndexedLedger: 51234567,
    lastIndexedAt: iso(INDEXER_FIXTURE_NOW - 20_000),
    staleAfterMs: 300_000,
  },
  stale: {
    lastIndexedLedger: 51200000,
    lastIndexedAt: iso(INDEXER_FIXTURE_NOW - 6 * 3_600_000),
    staleAfterMs: 300_000,
  },
  unknown: { lastIndexedLedger: null, lastIndexedAt: null, staleAfterMs: 300_000 },
};

export function proxySuccessEnvelope(
  resource: IndexerResourceName,
  data: unknown[],
  meta: { droppedRecords?: number; freshness?: IndexerFreshness; apiVersion?: string } = {}
) {
  return {
    ok: true,
    resource,
    data,
    meta: {
      apiVersion: meta.apiVersion ?? '1.3.0',
      droppedRecords: meta.droppedRecords ?? 0,
      freshness: meta.freshness ?? freshnessFixtures.fresh,
    },
  };
}

export function proxyErrorEnvelope(code: IndexerErrorCode, message = `fixture ${code}`) {
  return { ok: false, error: { code, message } };
}

/** Proxy responses the browser client must reject as `schema` errors. */
export const malformedProxyEnvelopes: Array<{ name: string; body: unknown }> = [
  { name: 'null', body: null },
  { name: 'bare upstream list', body: [{ address: ACTOR }] },
  { name: 'ok without data', body: { ok: true, resource: 'leaderboard', meta: {} } },
  {
    name: 'data is an object',
    body: { ...proxySuccessEnvelope('leaderboard', []), data: { rows: [] } },
  },
  {
    name: 'droppedRecords is a string',
    body: {
      ...proxySuccessEnvelope('leaderboard', []),
      meta: { ...proxySuccessEnvelope('leaderboard', []).meta, droppedRecords: '0' },
    },
  },
  {
    name: 'freshness timestamp is garbage',
    body: proxySuccessEnvelope('leaderboard', [], {
      freshness: { lastIndexedLedger: 1, lastIndexedAt: 'soon', staleAfterMs: 1 },
    }),
  },
  { name: 'error with unknown code', body: { ok: false, error: { code: 'kaboom', message: 'x' } } },
];
