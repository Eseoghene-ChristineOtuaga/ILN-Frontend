import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TopFundersWidget from '../TopFundersWidget';
import {
  freshnessFixtures,
  proxyErrorEnvelope,
  proxySuccessEnvelope,
} from '@/mocks/fixtures/indexer';

const addToastMock = vi.fn();
vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ addToast: addToastMock }),
}));

const fetchMock = vi.fn();
const CACHE_KEY = 'iln_top_funders_30d';

function leaderboard(rows: unknown[]) {
  return { ok: true, json: async () => proxySuccessEnvelope('leaderboard', rows) };
}

const rawFunder = (overrides: Record<string, unknown> = {}) => ({
  address: 'GFUNDERADDRESSLONGENOUGH1234',
  amountFunded: 1500,
  yieldEarned: 250,
  fundedCount: 4,
  avgDiscountRate: 2.5,
  ...overrides,
});

describe('TopFundersWidget', () => {
  beforeEach(() => {
    addToastMock.mockClear();
    fetchMock.mockReset();
    (global as any).fetch = fetchMock;
    window.localStorage.clear();
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
  });

  it('shows a loading state, then fetches and renders funders', async () => {
    fetchMock.mockResolvedValue(leaderboard([rawFunder()]));
    render(<TopFundersWidget />);
    expect(screen.getByText('Loading active LPs...')).toBeInTheDocument();

    await screen.findByText(/GFUNDE\.\.\./);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/indexer/leaderboard?type=lp&period=30d&limit=10',
      expect.objectContaining({ cache: 'no-store' })
    );
    expect(screen.getByText('4 invoices (30d)')).toBeInTheDocument();
  });

  it('shows an empty state when there are no active funders', async () => {
    fetchMock.mockResolvedValue(leaderboard([]));
    render(<TopFundersWidget />);
    await screen.findByText('No active LP leaderboard data is available right now.');
  });

  it('shows an explicit error, not an empty leaderboard, when the fetch fails', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    render(<TopFundersWidget />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/temporarily unavailable/i);
    expect(
      screen.queryByText('No active LP leaderboard data is available right now.')
    ).not.toBeInTheDocument();
  });

  it('surfaces typed indexer errors from the proxy', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: async () =>
        proxyErrorEnvelope('unauthorized', 'The indexer rejected the server credentials.'),
    });
    render(<TopFundersWidget />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The indexer rejected the server credentials.'
    );
  });

  it('shows freshness for fetched rows', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () =>
        proxySuccessEnvelope('leaderboard', [rawFunder()], {
          freshness: freshnessFixtures.unknown,
        }),
    });
    render(<TopFundersWidget />);
    expect(await screen.findByText('Indexer freshness unknown')).toBeInTheDocument();
  });

  it('shows an honest unavailable notice when the indexer returns 503 (down)', async () => {
    fetchMock.mockResolvedValue({ status: 503, json: async () => ({ error: 'unavailable' }) });
    render(<TopFundersWidget />);
    await screen.findByText(/temporarily unavailable/i);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.queryByText('No active LP leaderboard data is available right now.')).toBeNull();
  });

  it('serves from a fresh localStorage cache without refetching', async () => {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        savedAt: Date.now(),
        rows: [rawFunder({ address: 'GCACHED1234567890' })],
        freshness: freshnessFixtures.unknown,
      })
    );
    render(<TopFundersWidget />);
    await screen.findByText(/GCACHE\.\.\./);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('ignores legacy caches that carry no freshness metadata', async () => {
    window.localStorage.setItem(
      'iln_top_funders_30d',
      JSON.stringify({ savedAt: Date.now(), rows: [rawFunder({ address: 'GOLDCACHE1234567' })] })
    );
    fetchMock.mockResolvedValue(leaderboard([rawFunder()]));
    render(<TopFundersWidget />);
    await screen.findByText(/GFUNDE\.\.\./);
    expect(fetchMock).toHaveBeenCalled();
    expect(screen.queryByText(/GOLDCA\.\.\./)).not.toBeInTheDocument();
  });

  it('refetches when the localStorage cache is stale', async () => {
    window.localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        savedAt: Date.now() - 25 * 60 * 60 * 1000,
        freshness: freshnessFixtures.unknown,
        rows: [rawFunder({ address: 'GSTALE1234567890' })],
      })
    );
    fetchMock.mockResolvedValue(leaderboard([rawFunder()]));
    render(<TopFundersWidget />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });

  it('formats large amounts with M/K suffixes and shows medal badges for the top 3', async () => {
    fetchMock.mockResolvedValue(
      leaderboard([
        rawFunder({ address: 'GFIRSTFUNDER123456', amountFunded: 2_500_000, yieldEarned: 3_200 }),
      ])
    );
    render(<TopFundersWidget />);
    await screen.findByText(/GFIRST\.\.\./);
    expect(screen.getByText(/\$2\.50M/)).toBeInTheDocument();
    expect(screen.getByText(/\$3\.2K/)).toBeInTheDocument();
    expect(screen.getByText(/🥇/)).toBeInTheDocument();
  });

  it('copies an address to the clipboard and shows a success toast', async () => {
    fetchMock.mockResolvedValue(leaderboard([rawFunder()]));
    render(<TopFundersWidget />);
    const button = await screen.findByText(/GFUNDE\.\.\./);
    fireEvent.click(button);

    await waitFor(() =>
      expect(addToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', title: 'Address copied' })
      )
    );
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(rawFunder().address);
  });

  it('shows an error toast when the clipboard write fails', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    fetchMock.mockResolvedValue(leaderboard([rawFunder()]));
    render(<TopFundersWidget />);
    const button = await screen.findByText(/GFUNDE\.\.\./);
    fireEvent.click(button);

    await waitFor(() =>
      expect(addToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', title: 'Copy failed' })
      )
    );
  });

  it('normalizes rows using legacy field names and drops rows without an address', () => {
    fetchMock.mockResolvedValue(
      leaderboard([
        { lp: 'GLEGACY1234567890AB', metric1: 3, metric2: 1.1, metric3: 500, metric4: 20 },
        { totalFunded: 10 },
      ])
    );
    return (async () => {
      render(<TopFundersWidget />);
      await screen.findByText(/GLEGAC\.\.\./);
      expect(screen.getByText('3 invoices (30d)')).toBeInTheDocument();
    })();
  });
});
