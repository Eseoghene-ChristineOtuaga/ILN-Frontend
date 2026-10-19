/**
 * Every indexer-backed view × the fixture catalogue: typed proxy errors render
 * the matching accessible notice (with the proxy's safe detail) and are only
 * retried automatically when transient, malformed proxy envelopes are rejected,
 * and stale data is flagged. No view may fall back to generated data.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ActivityFeed from '@/components/ActivityFeed';
import DefaultRateChart from '@/components/charts/DefaultRateChart';
import FundingChart from '@/components/charts/FundingChart';
import {
  freshnessFixtures,
  malformedProxyEnvelopes,
  proxyErrorEnvelope,
  proxySuccessEnvelope,
} from '@/mocks/fixtures/indexer';
import { INDEXER_ERROR_STATUS, type IndexerErrorCode } from '@/lib/indexer/errors';
import type { IndexerResourceName } from '@/lib/indexer/types';

const CONSUMERS: Array<{
  name: string;
  resource: IndexerResourceName;
  element: React.ReactElement;
}> = [
  { name: 'ActivityFeed', resource: 'invoice.events', element: <ActivityFeed invoiceId={7n} /> },
  { name: 'FundingChart', resource: 'analytics.funding', element: <FundingChart /> },
  { name: 'DefaultRateChart', resource: 'analytics.defaults', element: <DefaultRateChart /> },
];

const ERROR_CODES = Object.keys(INDEXER_ERROR_STATUS) as IndexerErrorCode[];

const originalFetch = global.fetch;

/** Notice variant each proxy error code must render as. */
const NOTICE_FOR_CODE: Record<IndexerErrorCode, string> = {
  unauthorized: 'unauthorized',
  forbidden: 'unauthorized',
  rate_limited: 'rate-limited',
  schema: 'malformed',
  version_mismatch: 'malformed',
  bad_request: 'malformed',
  unknown_resource: 'malformed',
  timeout: 'unavailable',
  network: 'unavailable',
  upstream: 'unavailable',
  not_configured: 'unavailable',
  not_found: 'unavailable',
};
const TRANSIENT = new Set<IndexerErrorCode>(['timeout', 'network', 'upstream']);

function respondWith(body: unknown, status = 200) {
  // A fresh Response per call: retries must not see an already-consumed body.
  global.fetch = vi.fn().mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
  );
}

/** Text that only appears when a view renders indexer rows. */
const DATA_MARKERS = [/Invoice submitted by/, /Invoice funded by/, /Total Funding/, /%$/];

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe.each(CONSUMERS)('$name', ({ resource, element }) => {
  it.each(ERROR_CODES)('renders the %s failure accessibly', async (code) => {
    respondWith(
      proxyErrorEnvelope(code, `Fixture message for ${code}.`),
      INDEXER_ERROR_STATUS[code]
    );
    render(element);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-testid', `indexer-notice-${NOTICE_FOR_CODE[code]}`);
    // Rate limiting is handled from the HTTP status and Retry-After, not the envelope detail.
    if (code !== 'rate_limited') expect(alert).toHaveTextContent(`Fixture message for ${code}.`);

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    if (TRANSIENT.has(code)) expect(calls).toBeGreaterThan(1);
    else expect(calls).toBe(1);

    for (const marker of DATA_MARKERS.slice(0, 3)) {
      expect(screen.queryByText(marker)).not.toBeInTheDocument();
    }
  });

  it.each(malformedProxyEnvelopes.map((f) => [f.name, f.body] as const))(
    'treats a malformed proxy envelope (%s) as a schema error',
    async (_name, body) => {
      respondWith(body);
      render(element);
      expect(await screen.findByRole('alert')).toHaveAttribute(
        'data-testid',
        'indexer-notice-malformed'
      );
    }
  );

  it('rejects an envelope for a different resource', async () => {
    const other: IndexerResourceName =
      resource === 'leaderboard' ? 'invoice.events' : 'leaderboard';
    respondWith(proxySuccessEnvelope(other, []));
    render(element);
    expect(await screen.findByRole('alert')).toHaveAttribute(
      'data-testid',
      'indexer-notice-malformed'
    );
  });

  it('flags stale data', async () => {
    respondWith(proxySuccessEnvelope(resource, [], { freshness: freshnessFixtures.stale }));
    render(element);
    const badge = await screen.findByText(/Data may be out of date/);
    expect(badge.closest('[data-freshness]')).toHaveAttribute('data-freshness', 'stale');
  });

  it('labels unknown freshness rather than implying live data', async () => {
    respondWith(proxySuccessEnvelope(resource, [], { freshness: freshnessFixtures.unknown }));
    render(element);
    expect(await screen.findByText('Indexer freshness unknown')).toBeInTheDocument();
  });

  it('discloses dropped partial records', async () => {
    respondWith(proxySuccessEnvelope(resource, [], { droppedRecords: 3 }));
    render(element);
    expect(
      await screen.findByText(/3 records from the indexer could not be displayed/)
    ).toBeInTheDocument();
  });
});
