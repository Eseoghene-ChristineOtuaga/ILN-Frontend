import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import FundingChart from '../FundingChart';
import DefaultRateChart from '../DefaultRateChart';

const originalFetch = global.fetch;

function envelope(resource: string, data: unknown[]) {
  return {
    ok: true,
    json: async () => ({
      ok: true,
      resource,
      data,
      meta: {
        apiVersion: '1.0.0',
        droppedRecords: 0,
        freshness: { lastIndexedLedger: null, lastIndexedAt: null, staleAfterMs: 300_000 },
      },
    }),
  };
}

function errorEnvelope(code: string, message: string, status = 502) {
  return { ok: false, status, json: async () => ({ ok: false, error: { code, message } }) };
}

const fetchMock = () => global.fetch as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  global.fetch = vi.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('FundingChart', () => {
  it('requests funding through the proxy and refetches when the range changes', async () => {
    fetchMock().mockResolvedValue(envelope('analytics.funding', []));
    render(<FundingChart />);

    await screen.findByText('No funding activity in this period');
    expect(fetchMock().mock.calls[0][0]).toBe('/api/indexer/analytics/funding?period=30d');

    fireEvent.click(screen.getByRole('button', { name: '7D' }));
    await waitFor(() =>
      expect(fetchMock().mock.calls.at(-1)?.[0]).toBe('/api/indexer/analytics/funding?period=7d')
    );
  });

  it('shows a typed failure instead of generated funding data', async () => {
    fetchMock().mockResolvedValue(
      errorEnvelope('unauthorized', 'The indexer rejected the server credentials.')
    );
    render(<FundingChart />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-testid', 'indexer-notice-unauthorized');
    expect(alert).toHaveTextContent('The indexer rejected the server credentials.');
    // Credential failures are never retried automatically.
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('No funding activity in this period')).not.toBeInTheDocument();
    expect(screen.queryByText(/Total Funding/)).not.toBeInTheDocument();
  });

  it('explains an indexer API version mismatch without retrying it', async () => {
    fetchMock().mockResolvedValue(
      errorEnvelope(
        'version_mismatch',
        'The indexer API version 2.0.0 is not supported. This app requires 1.x (>= 1.0).'
      )
    );
    render(<FundingChart />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-testid', 'indexer-notice-malformed');
    expect(alert).toHaveTextContent('The indexer API version 2.0.0 is not supported.');
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });
});

describe('DefaultRateChart', () => {
  it('renders summary tiles from indexer data', async () => {
    fetchMock().mockResolvedValue(
      envelope('analytics.defaults', [
        { date: '2026-08', label: 'Aug 2026', defaulted: 1, funded: 10, defaultRate: 10 },
        { date: '2026-09', label: 'Sep 2026', defaulted: 1, funded: 20, defaultRate: 5 },
      ])
    );
    render(<DefaultRateChart />);

    expect(await screen.findByText('5.00%')).toBeInTheDocument();
    expect(screen.getByText('6.67%')).toBeInTheDocument();
    expect(screen.getByText('↓')).toBeInTheDocument();
    expect(fetchMock().mock.calls[0][0]).toBe('/api/indexer/analytics/defaults?period=12m');
  });

  it('shows placeholders, not zero rates or mock data, when the indexer times out', async () => {
    fetchMock().mockResolvedValue(
      errorEnvelope('timeout', 'The indexer took too long to respond.', 504)
    );
    render(<DefaultRateChart />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-testid', 'indexer-notice-unavailable');
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.queryByText('0.00%')).not.toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(3);
  });
});
