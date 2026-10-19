import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_INDEXER_STALE_AFTER_MS,
  evaluateIndexerFreshness,
  formatIndexerAge,
  isIndexerFreshness,
  parseStaleAfterMs,
  readIndexerFreshness,
} from '../freshness';
import { loadIndexerResource } from '../server';

const NOW = Date.parse('2026-10-16T12:00:00Z');

function headers(init: Record<string, string>) {
  return new Headers(init);
}

describe('readIndexerFreshness', () => {
  it('reads ledger and ISO close time', () => {
    expect(
      readIndexerFreshness(
        headers({
          'X-Indexer-Last-Ledger': '51234567',
          'X-Indexer-Last-Indexed-At': '2026-10-16T11:58:30Z',
        }),
        60_000,
        NOW
      )
    ).toEqual({
      lastIndexedLedger: 51234567,
      lastIndexedAt: '2026-10-16T11:58:30.000Z',
      staleAfterMs: 60_000,
    });
  });

  it('accepts epoch seconds and milliseconds', () => {
    const seconds = String(Math.floor(NOW / 1000) - 30);
    const millis = String(NOW - 30_000);
    for (const value of [seconds, millis]) {
      expect(
        readIndexerFreshness(headers({ 'X-Indexer-Last-Indexed-At': value }), 60_000, NOW)
          .lastIndexedAt
      ).toBe('2026-10-16T11:59:30.000Z');
    }
  });

  it('reports missing headers as unknown', () => {
    expect(readIndexerFreshness(headers({}), 60_000, NOW)).toEqual({
      lastIndexedLedger: null,
      lastIndexedAt: null,
      staleAfterMs: 60_000,
    });
  });

  it.each([
    ['negative ledger', 'X-Indexer-Last-Ledger', '-4', 'lastIndexedLedger'],
    ['fractional ledger', 'X-Indexer-Last-Ledger', '12.5', 'lastIndexedLedger'],
    ['zero ledger', 'X-Indexer-Last-Ledger', '0', 'lastIndexedLedger'],
    ['garbage time', 'X-Indexer-Last-Indexed-At', 'yesterday', 'lastIndexedAt'],
    ['far-future time', 'X-Indexer-Last-Indexed-At', '2027-01-01T00:00:00Z', 'lastIndexedAt'],
  ] as const)('reports a %s as unknown rather than guessing', (_label, header, value, field) => {
    expect(readIndexerFreshness(headers({ [header]: value }), 60_000, NOW)[field]).toBeNull();
  });
});

describe('parseStaleAfterMs', () => {
  it('defaults, converts seconds, and clamps', () => {
    expect(parseStaleAfterMs(undefined)).toBe(DEFAULT_INDEXER_STALE_AFTER_MS);
    expect(parseStaleAfterMs('nope')).toBe(DEFAULT_INDEXER_STALE_AFTER_MS);
    expect(parseStaleAfterMs('120')).toBe(120_000);
    expect(parseStaleAfterMs('1')).toBe(30_000);
    expect(parseStaleAfterMs('9999999')).toBe(24 * 60 * 60_000);
  });
});

describe('evaluateIndexerFreshness', () => {
  const base = { lastIndexedLedger: 10, staleAfterMs: 60_000 };

  it('is fresh within the threshold and stale beyond it', () => {
    expect(
      evaluateIndexerFreshness({ ...base, lastIndexedAt: '2026-10-16T11:59:30Z' }, NOW)
    ).toMatchObject({ state: 'fresh', ageMs: 30_000 });
    expect(
      evaluateIndexerFreshness({ ...base, lastIndexedAt: '2026-10-16T11:58:00Z' }, NOW)
    ).toMatchObject({ state: 'stale', ageMs: 120_000 });
  });

  it('is unknown without a timestamp, even with a ledger', () => {
    expect(evaluateIndexerFreshness({ ...base, lastIndexedAt: null }, NOW)).toEqual({
      state: 'unknown',
      lastIndexedLedger: 10,
      lastIndexedAt: null,
      ageMs: null,
    });
  });

  it('clamps small clock skew to zero age', () => {
    expect(
      evaluateIndexerFreshness({ ...base, lastIndexedAt: '2026-10-16T12:00:05Z' }, NOW).ageMs
    ).toBe(0);
  });
});

describe('isIndexerFreshness', () => {
  it('accepts valid and explicitly unknown metadata', () => {
    expect(
      isIndexerFreshness({ lastIndexedLedger: null, lastIndexedAt: null, staleAfterMs: 1 })
    ).toBe(true);
  });

  it.each([
    null,
    {},
    { lastIndexedLedger: '5', lastIndexedAt: null, staleAfterMs: 1 },
    { lastIndexedLedger: 5, lastIndexedAt: 'not-a-date', staleAfterMs: 1 },
    { lastIndexedLedger: 5, lastIndexedAt: null, staleAfterMs: 0 },
  ])('rejects malformed metadata %#', (value) => {
    expect(isIndexerFreshness(value)).toBe(false);
  });
});

describe('formatIndexerAge', () => {
  it.each([
    [10_000, 'just now'],
    [60_000, '1 minute ago'],
    [5 * 60_000, '5 minutes ago'],
    [3 * 3_600_000, '3 hours ago'],
    [3 * 86_400_000, '3 days ago'],
  ])('%i ms → %s', (ms, label) => {
    expect(formatIndexerAge(ms)).toBe(label);
  });
});

describe('loadIndexerResource freshness', () => {
  it('forwards freshness headers using the configured threshold', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('[]', {
        headers: {
          'X-Indexer-Api-Version': '1.0.0',
          'X-Indexer-Last-Ledger': '777',
          'X-Indexer-Last-Indexed-At': new Date(Date.now() - 1000).toISOString(),
        },
      })
    );
    const envelope = await loadIndexerResource(['leaderboard'], new URLSearchParams(), {
      fetchImpl,
      env: { INDEXER_URL: 'https://indexer.example', INDEXER_STALE_AFTER_SECONDS: '90' },
    });
    expect(envelope.meta.freshness).toMatchObject({ lastIndexedLedger: 777, staleAfterMs: 90_000 });
    expect(envelope.meta.freshness.lastIndexedAt).toEqual(expect.any(String));
  });
});
