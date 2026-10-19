import { render, screen, fireEvent, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// next/link needs the app-router context at runtime; render a plain anchor instead.
vi.mock('next/link', () => ({
  __esModule: true,
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

// Control the data the banner sees.
vi.mock('@/hooks/queries/useParameterUpdates', () => ({
  useParameterUpdates: vi.fn(),
}));

import { useParameterUpdates } from '@/hooks/queries/useParameterUpdates';
import ParameterUpdateBanner from '../ParameterUpdateBanner';
import type { ParameterUpdateEvent } from '@/utils/governance';

const mockedHook = vi.mocked(useParameterUpdates);

function event(overrides: Partial<ParameterUpdateEvent> = {}): ParameterUpdateEvent {
  return {
    id: 'aa:protocol_fee_rate_bps',
    proposalId: 7,
    parameter: 'protocol_fee_rate_bps',
    label: 'Protocol fee rate',
    oldValue: '50 (0.5%)',
    newValue: '30 (0.3%)',
    rawNewValue: 30n,
    updatedAt: Math.floor(Date.now() / 1000),
    ledger: 1000,
    txHash: 'aa',
    source: 'protocol',
    ...overrides,
  };
}

function setUpdates(events: ParameterUpdateEvent[]) {
  // The component only reads `.data`; cast is fine for the test double.
  mockedHook.mockReturnValue({ data: events } as ReturnType<typeof useParameterUpdates>);
}

const STORAGE_KEY = 'iln:dismissed-parameter-updates';

describe('ParameterUpdateBanner (#153)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    mockedHook.mockReset();
  });

  test('renders an announcement with the parameter label and new value', () => {
    setUpdates([event()]);
    render(<ParameterUpdateBanner />);

    expect(
      screen.getByText('Protocol update: Protocol fee rate changed to 30 (0.3%)')
    ).toBeInTheDocument();
  });

  test('links to the governance proposal that enacted the change', () => {
    setUpdates([event({ proposalId: 7 })]);
    render(<ParameterUpdateBanner />);

    expect(screen.getByRole('link', { name: /view governance proposal/i })).toHaveAttribute(
      'href',
      '/governance/7'
    );
  });

  test('omits the proposal link for a change not enacted by a proposal (#1057)', () => {
    setUpdates([event({ proposalId: null, source: 'governance' })]);
    render(<ParameterUpdateBanner />);

    expect(
      screen.getByText('Protocol update: Protocol fee rate changed to 30 (0.3%)')
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /view governance proposal/i })).toBeNull();
  });

  test('shows at most two banners simultaneously', () => {
    setUpdates([
      event({ id: 'a', proposalId: 1 }),
      event({ id: 'b', proposalId: 2 }),
      event({ id: 'c', proposalId: 3 }),
    ]);
    render(<ParameterUpdateBanner />);

    expect(screen.getAllByTestId('parameter-update-banner')).toHaveLength(2);
  });

  test('dismissing a banner hides it and persists the id to localStorage', () => {
    setUpdates([event({ id: '7:fee_rate_bps' })]);
    render(<ParameterUpdateBanner />);

    const banner = screen.getByTestId('parameter-update-banner');
    fireEvent.click(within(banner).getByTestId('dismiss-parameter-update'));

    expect(screen.queryByTestId('parameter-update-banner')).not.toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '[]')).toContain(
      '7:fee_rate_bps'
    );
  });

  test('does not render announcements already dismissed in a previous session', () => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(['7:fee_rate_bps']));
    setUpdates([event({ id: '7:fee_rate_bps' })]);
    render(<ParameterUpdateBanner />);

    expect(screen.queryByTestId('parameter-update-banner')).not.toBeInTheDocument();
  });

  test('renders nothing when there are no recent updates', () => {
    setUpdates([]);
    const { container } = render(<ParameterUpdateBanner />);

    expect(container).toBeEmptyDOMElement();
  });
});
