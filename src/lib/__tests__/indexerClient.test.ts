import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkIndexerHealth,
  fetchDefaultRateData,
  fetchFundingData,
  fetchInvoiceEvents,
  fetchLeaderboard,
} from '../indexerClient';
import { proxyErrorEnvelope, proxySuccessEnvelope } from '@/mocks/fixtures/indexer';
import type { IndexerResourceName } from '@/lib/indexer/types';

const originalFetch = global.fetch;

function serve(resource: IndexerResourceName, data: unknown[] = []) {
  global.fetch = vi
    .fn()
    .mockImplementation(
      async () => new Response(JSON.stringify(proxySuccessEnvelope(resource, data)))
    );
}

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('indexerClient readers (#1102–#1105) go through the proxy', () => {
  it.each([
    ['invoice.events', () => fetchInvoiceEvents(9n), '/api/indexer/invoices/9/events'],
    [
      'analytics.defaults',
      () => fetchDefaultRateData(),
      '/api/indexer/analytics/defaults?period=12m',
    ],
    [
      'analytics.funding',
      () => fetchFundingData({ period: '7d' }),
      '/api/indexer/analytics/funding?period=7d',
    ],
    [
      'leaderboard',
      () => fetchLeaderboard(10, 'payer'),
      '/api/indexer/leaderboard?type=payer&period=all&limit=10',
    ],
  ] as const)('%s', async (resource, call, url) => {
    serve(resource);
    await call();
    const [requested, init] = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(requested).toBe(url);
    expect(JSON.stringify(init?.headers ?? {})).not.toMatch(/X-API-Key|Authorization/i);
  });

  it('reports health from a minimal allow-listed proxy request', async () => {
    serve('leaderboard');
    await expect(checkIndexerHealth()).resolves.toBe(true);

    global.fetch = vi
      .fn()
      .mockImplementation(
        async () =>
          new Response(JSON.stringify(proxyErrorEnvelope('not_configured')), { status: 503 })
      );
    await expect(checkIndexerHealth()).resolves.toBe(false);
  });
});
