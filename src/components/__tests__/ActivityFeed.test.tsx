import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ActivityFeed from '../ActivityFeed';
import {
  freshnessFixtures,
  proxyErrorEnvelope,
  proxySuccessEnvelope,
} from '@/mocks/fixtures/indexer';

function envelope(events: unknown[], meta: Parameters<typeof proxySuccessEnvelope>[2] = {}) {
  return { ok: true, json: async () => proxySuccessEnvelope('invoice.events', events, meta) };
}

// Mock fetch
const globalFetch = global.fetch;

describe('ActivityFeed', () => {
  beforeEach(() => {
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = globalFetch;
    vi.clearAllMocks();
  });

  it('should render loading state initially', () => {
    (global.fetch as any).mockReturnValue(new Promise(() => {})); // Never resolves
    render(<ActivityFeed invoiceId={1n} />);
    expect(document.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('should render empty state when no events', async () => {
    (global.fetch as any).mockResolvedValue(envelope([]));

    render(<ActivityFeed invoiceId={1n} />);

    await waitFor(() => {
      expect(screen.getByText('No activity yet for this invoice.')).toBeInTheDocument();
    });
  });

  it('should render events correctly and link actor profile', async () => {
    const mockEvents = [
      {
        type: 'submitted',
        timestamp: Date.now() - 3600000,
        actor: 'GABC12345678901234567890123456789012345678901234567890123456',
      },
      {
        type: 'funded',
        timestamp: Date.now() - 1800000,
        actor: 'GDEF5678901234567890123456789012345678901234567890123456',
        data: { amount: '5000000000' },
      },
    ];

    (global.fetch as any).mockResolvedValue(envelope(mockEvents));

    render(<ActivityFeed invoiceId={1n} />);

    await waitFor(() => {
      expect(screen.getByText(/Invoice submitted by/)).toBeInTheDocument();
      expect(screen.getByText(/Invoice funded by/)).toBeInTheDocument();
      expect(screen.getAllByRole('link', { name: 'GABC...3456' }).length).toBeGreaterThan(0);
      expect(screen.getByText('1 hours ago')).toBeInTheDocument();
    });
  });

  it('should toggle raw event data when requested', async () => {
    const mockEvents = [
      {
        type: 'submitted',
        timestamp: Date.now() - 3600000,
        actor: 'GABC12345678901234567890123456789012345678901234567890123456',
      },
    ];

    (global.fetch as any).mockResolvedValue(envelope(mockEvents));

    render(<ActivityFeed invoiceId={1n} />);

    await waitFor(() => {
      expect(screen.getByText(/Invoice submitted by/)).toBeInTheDocument();
    });

    const toggle = screen.getByRole('button', { name: 'Show raw event data' });
    fireEvent.click(toggle);
    expect(screen.getByText(/"type": "submitted"/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide raw event data' })).toBeInTheDocument();
  });

  it('shows an honest unavailable notice when the indexer cannot be reached', async () => {
    (global.fetch as any).mockRejectedValue(new Error('Network error'));

    render(<ActivityFeed invoiceId={1n} />);

    await waitFor(() => {
      expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
      expect(screen.getByRole('alert')).toBeInTheDocument();
      // No fabricated audit-trail events should be shown when the indexer is down.
      expect(screen.queryByText(/Invoice submitted by/)).not.toBeInTheDocument();
    });
  });

  it('does not show mock events when the indexer returns a non-ok response', async () => {
    (global.fetch as any).mockResolvedValue({ ok: false, json: async () => [] });

    render(<ActivityFeed invoiceId={1n} />);

    await waitFor(() => {
      expect(screen.getByText(/temporarily unavailable/i)).toBeInTheDocument();
      expect(screen.queryByText(/Invoice funded by/)).not.toBeInTheDocument();
    });
  });

  it('requests events through the same-origin indexer proxy', async () => {
    (global.fetch as any).mockResolvedValue(envelope([]));
    render(<ActivityFeed invoiceId={42n} />);
    await waitFor(() => expect(global.fetch).toHaveBeenCalled());
    expect((global.fetch as any).mock.calls[0][0]).toBe('/api/indexer/invoices/42/events');
  });

  it('flags an empty feed from a lagging indexer as stale rather than definitive', async () => {
    (global.fetch as any).mockResolvedValue(envelope([], { freshness: freshnessFixtures.stale }));
    render(<ActivityFeed invoiceId={1n} />);
    expect(await screen.findByText('No activity yet for this invoice.')).toBeInTheDocument();
    expect(screen.getByText(/Data may be out of date/).closest('[data-freshness]')).toHaveAttribute(
      'data-freshness',
      'stale'
    );
  });

  it('discloses records the proxy dropped as malformed', async () => {
    (global.fetch as any).mockResolvedValue(
      envelope([{ type: 'submitted', timestamp: Date.now() - 60_000 }], { droppedRecords: 2 })
    );
    render(<ActivityFeed invoiceId={1n} />);
    expect(
      await screen.findByText(/2 records from the indexer could not be displayed/)
    ).toBeInTheDocument();
  });

  it('explains a version mismatch without retrying it', async () => {
    (global.fetch as any).mockResolvedValue({
      ok: false,
      status: 502,
      json: async () =>
        proxyErrorEnvelope('version_mismatch', 'The indexer API version 2.0.0 is not supported.'),
    });
    render(<ActivityFeed invoiceId={1n} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveAttribute('data-testid', 'indexer-notice-malformed');
    expect(alert).toHaveTextContent('The indexer API version 2.0.0 is not supported.');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
