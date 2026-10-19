/**
 * Route handler ↔ fixture indexer over real HTTP semantics (MSW).
 * Exercises auth, timeout, schema, partial-record, version and freshness
 * fixtures end to end through `GET /api/indexer/[...path]`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { server } from '@/mocks/server';
import {
  indexerFixtureEnv,
  indexerHeaderFixtures,
  indexerUpstreamFailures,
  indexerUpstreamHandler,
  INDEXER_FIXTURE_KEY,
  INDEXER_FIXTURE_URL,
  INDEXER_PROXY_PATHS,
  INDEXER_RESOURCE_NAMES,
  malformedIndexerPayloads,
  validIndexerPayloads,
  type CapturedUpstreamRequest,
} from '@/mocks/fixtures/indexer';
import type { IndexerResourceName } from '@/lib/indexer/types';
import { GET } from '../[...path]/route';

async function callProxy(resource: IndexerResourceName) {
  const url = new URL(`http://localhost/api/indexer/${INDEXER_PROXY_PATHS[resource]}`);
  const segments = url.pathname.replace('/api/indexer/', '').split('/');
  const res = await GET(new NextRequest(url), { params: Promise.resolve({ path: segments }) });
  const text = await res.text();
  return { res, text, body: JSON.parse(text) };
}

function expectNoLeak(text: string) {
  expect(text).not.toContain(INDEXER_FIXTURE_KEY);
  expect(text).not.toContain(INDEXER_FIXTURE_URL);
  expect(text).not.toContain('fixture.test');
}

beforeEach(() => {
  for (const [key, value] of Object.entries(indexerFixtureEnv)) vi.stubEnv(key, value);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('indexer proxy integration: valid payloads', () => {
  it.each(INDEXER_RESOURCE_NAMES)(
    '%s: authenticates upstream and returns a clean envelope',
    async (resource) => {
      const log: CapturedUpstreamRequest[] = [];
      server.use(indexerUpstreamHandler(resource, { body: validIndexerPayloads[resource] }, log));

      const { res, text, body } = await callProxy(resource);

      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        ok: true,
        resource,
        meta: {
          apiVersion: '1.3.0',
          droppedRecords: 0,
          freshness: { lastIndexedLedger: 51234567, lastIndexedAt: expect.any(String) },
        },
      });
      expect(log).toHaveLength(1);
      expect(log[0].authorization).toBe(`Bearer ${INDEXER_FIXTURE_KEY}`);
      expect(log[0].acceptVersion).toBe('1');
      expectNoLeak(text);
    }
  );
});

describe('indexer proxy integration: malformed payloads', () => {
  it.each(malformedIndexerPayloads.map((f) => [f.name, f] as const))(
    '%s',
    async (_name, fixture) => {
      server.use(indexerUpstreamHandler(fixture.resource, { body: fixture.body }));

      const { res, text, body } = await callProxy(fixture.resource);

      if (fixture.expect.kind === 'schema') {
        expect(res.status).toBe(502);
        expect(body).toEqual({ ok: false, error: { code: 'schema', message: expect.any(String) } });
      } else {
        expect(res.status).toBe(200);
        expect(body.data).toHaveLength(fixture.expect.kept);
        expect(body.meta.droppedRecords).toBe(fixture.expect.dropped);
      }
      expectNoLeak(text);
    }
  );
});

describe('indexer proxy integration: upstream failures', () => {
  it.each(indexerUpstreamFailures.map((f) => [f.name, f] as const))(
    '%s',
    async (_name, fixture) => {
      server.use(indexerUpstreamHandler('leaderboard', fixture));

      const { res, text, body } = await callProxy('leaderboard');

      expect(res.status).toBe(fixture.expectedStatus);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(body).toEqual({
        ok: false,
        error: { code: fixture.expectedCode, message: expect.any(String) },
      });
      expectNoLeak(text);
    },
    5_000
  );

  it('rejects requests before contacting the indexer when the credential is misnamed', async () => {
    vi.stubEnv('NEXT_PUBLIC_INDEXER_API_KEY', INDEXER_FIXTURE_KEY);
    const log: CapturedUpstreamRequest[] = [];
    server.use(indexerUpstreamHandler('leaderboard', { body: [] }, log));

    const res = await GET(new NextRequest('http://localhost/api/indexer/leaderboard'), {
      params: Promise.resolve({ path: ['leaderboard'] }),
    });

    const text = await res.text();
    expect(res.status).toBe(503);
    expect(JSON.parse(text).error.code).toBe('not_configured');
    expect(log).toHaveLength(0);
    expectNoLeak(text);
  });
});

describe('indexer proxy integration: freshness', () => {
  it('passes stale freshness through for the browser to flag', async () => {
    server.use(
      indexerUpstreamHandler('invoice.events', {
        body: validIndexerPayloads['invoice.events'],
        headers: indexerHeaderFixtures.stale,
      })
    );
    const { body } = await callProxy('invoice.events');
    expect(body.meta.freshness).toEqual({
      lastIndexedLedger: 51200000,
      lastIndexedAt: indexerHeaderFixtures.stale['X-Indexer-Last-Indexed-At'],
      staleAfterMs: 300_000,
    });
  });

  it('reports malformed freshness headers as unknown without failing the data', async () => {
    server.use(
      indexerUpstreamHandler('invoice.events', {
        body: validIndexerPayloads['invoice.events'],
        headers: indexerHeaderFixtures.malformedFreshness,
      })
    );
    const { res, body } = await callProxy('invoice.events');
    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.meta.freshness).toEqual({
      lastIndexedLedger: null,
      lastIndexedAt: null,
      staleAfterMs: 300_000,
    });
  });
});
