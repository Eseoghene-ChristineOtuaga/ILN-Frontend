import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRESHNESS_TICK_MS, IndexerFreshnessBadge } from '../IndexerStatus';

const NOW = Date.parse('2026-10-16T12:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('IndexerFreshnessBadge', () => {
  it('shows the last indexed ledger and age when fresh', () => {
    render(
      <IndexerFreshnessBadge
        freshness={{
          lastIndexedLedger: 51234567,
          lastIndexedAt: '2026-10-16T11:58:00Z',
          staleAfterMs: 300_000,
        }}
      />
    );
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('data-freshness', 'fresh');
    expect(badge).toHaveTextContent('Indexed through ledger #51,234,567 · updated 2 minutes ago');
  });

  it('warns when data is older than the threshold', () => {
    render(
      <IndexerFreshnessBadge
        freshness={{
          lastIndexedLedger: 42,
          lastIndexedAt: '2026-10-16T09:00:00Z',
          staleAfterMs: 300_000,
        }}
      />
    );
    const badge = screen.getByRole('status');
    expect(badge).toHaveAttribute('data-freshness', 'stale');
    expect(badge).toHaveTextContent(
      'Data may be out of date · last indexed 3 hours ago (ledger #42)'
    );
  });

  it('says freshness is unknown instead of implying live data', () => {
    render(
      <IndexerFreshnessBadge
        freshness={{ lastIndexedLedger: null, lastIndexedAt: null, staleAfterMs: 300_000 }}
      />
    );
    expect(screen.getByRole('status')).toHaveTextContent('Indexer freshness unknown');
    expect(screen.getByRole('status')).toHaveAttribute('data-freshness', 'unknown');
  });

  it('turns stale while the view stays open', () => {
    render(
      <IndexerFreshnessBadge
        freshness={{
          lastIndexedLedger: 1,
          lastIndexedAt: '2026-10-16T11:59:30Z',
          staleAfterMs: 60_000,
        }}
      />
    );
    expect(screen.getByRole('status')).toHaveAttribute('data-freshness', 'fresh');

    act(() => {
      vi.advanceTimersByTime(FRESHNESS_TICK_MS * 2);
    });
    expect(screen.getByRole('status')).toHaveAttribute('data-freshness', 'stale');
  });
});
