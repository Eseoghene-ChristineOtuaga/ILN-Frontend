/**
 * Screen-reader governance voting journey gate (#1127).
 *
 * axe-checks each step of the real voting flow -- the proposal list, the
 * proposal detail page, and the confirm-vote dialog it opens -- rather than
 * just the page's resting state, since a dialog injected into the DOM at
 * runtime (as this one is) isn't covered by a single page-load axe scan.
 * Also asserts the dialog carries the ARIA semantics a screen reader needs
 * to announce it (role="dialog", aria-modal, aria-labelledby), and that the
 * voting journey hands the toast layer an announceable title/message.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { axe } from 'jest-axe';
import { vi, describe, it, beforeEach, expect } from 'vitest';
import GovernancePage from '../../app/governance/page';
import ProposalDetailPage from '../../app/governance/[id]/page';
import { useWallet } from '@/context/WalletContext';
import { useTransaction } from '@/hooks/useTransaction';
import { useToast } from '@/context/ToastContext';
import { fetchProposal, fetchProposals } from '@/utils/governance';

vi.mock('next/navigation', () => ({
  useParams: vi.fn(() => ({ id: '3' })),
  useRouter: vi.fn(() => ({ replace: vi.fn() })),
}));

vi.mock('@/context/WalletContext', () => ({
  useWallet: vi.fn(),
}));

vi.mock('@/context/NotificationContext', () => ({
  useNotification: () => ({
    notifications: [],
    unreadCount: 0,
    setNotifications: vi.fn(),
    addNotification: vi.fn(),
    markAsRead: vi.fn(),
    markAllAsRead: vi.fn(),
    clearUnread: vi.fn(),
    isRead: vi.fn(() => true),
  }),
}));

vi.mock('@/hooks/useTransaction', () => ({
  useTransaction: vi.fn(),
}));

vi.mock('@/context/ToastContext', () => ({
  useToast: vi.fn(),
}));

vi.mock('@/hooks/useDocumentTitle', () => ({
  useDocumentTitle: vi.fn(),
}));

vi.mock('@/components/Footer', () => ({
  default: () => <footer data-testid="footer">Footer</footer>,
}));

vi.mock('@/components/Navbar', () => ({
  default: () => <nav data-testid="navbar">Navigation</nav>,
}));

vi.mock('@/components/governance/TokenAllowlistPanel', () => ({
  default: () => <div data-testid="token-allowlist">Token Allowlist Panel</div>,
}));

vi.mock('@/utils/governance', async () => {
  const actual = await vi.importActual<typeof import('@/utils/governance')>('@/utils/governance');
  return {
    ...actual,
    fetchProposal: vi.fn(),
    fetchProposals: vi.fn(),
    executeProposal: vi.fn(),
    // Hits Soroban RPC for real otherwise -- not safe to let run in tests.
    getVotingPower: vi.fn(() => Promise.resolve(100)),
  };
});

const mockUseWallet = useWallet as unknown as vi.Mock;
const mockUseTransaction = useTransaction as unknown as vi.Mock;
const mockUseToast = useToast as unknown as vi.Mock;
const mockFetchProposal = fetchProposal as unknown as vi.Mock;
const mockFetchProposals = fetchProposals as unknown as vi.Mock;
// Mirrors the real `useTransaction.execute`, which catches the operation's
// failure, reports it through a toast and returns null. Without the catch a
// rejected governance write (e.g. a typed GovernanceTxError) escapes as an
// unhandled rejection instead of being handled by the component under test.
const mockExecute = vi.fn(async (operation: any) => {
  try {
    return await operation(async () => 'signed-xdr');
  } catch {
    return null;
  }
});

const activeProposal = {
  id: 3,
  title: 'Enable EURC Support',
  description: 'Enable EURC token support for invoices.',
  type: 'ProtocolUpgrade' as const,
  status: 'Active' as const,
  proposer: 'GCZX...1234',
  createdAt: Math.floor(Date.now() / 1000) - 2 * 86400,
  votingStartsAt: Math.floor(Date.now() / 1000) - 2 * 86400,
  votingEndsAt: Math.floor(Date.now() / 1000) + 5 * 86400,
  votesFor: 215800,
  votesAgainst: 44100,
  quorumRequired: 100000,
  parameterChanges: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockUseWallet.mockReturnValue({
    address: 'GABCD...WXYZ',
    isConnected: true,
    connect: vi.fn(),
    signTx: vi.fn().mockResolvedValue('signed-xdr'),
  });
  mockUseToast.mockReturnValue({
    addToast: vi.fn(() => 'toast-id'),
    updateToast: vi.fn(),
  });
  mockUseTransaction.mockReturnValue({
    execute: mockExecute,
    loading: false,
    signingModal: null,
  });
  mockFetchProposal.mockResolvedValue(activeProposal);
  mockFetchProposals.mockResolvedValue([activeProposal]);
});

describe('Screen-reader governance voting journey (#1127)', () => {
  it('proposal list page has no detectable a11y violations', async () => {
    const { container } = render(<GovernancePage />);
    await waitFor(() => {
      expect(screen.getByText(/Enable EURC Support/i)).toBeInTheDocument();
    });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('proposal detail page has no detectable a11y violations before voting', async () => {
    const { container } = render(<ProposalDetailPage />);
    await screen.findByRole('button', { name: /^For$/i });
    expect(await axe(container)).toHaveNoViolations();
  });

  it('the confirm-vote dialog is announced as a modal dialog and is itself a11y-clean', async () => {
    const { container } = render(<ProposalDetailPage />);
    const forButton = await screen.findByRole('button', { name: /^For$/i });
    fireEvent.click(forButton);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby');

    const labelledBy = dialog.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)).toHaveTextContent('Confirm Vote');

    expect(await axe(container)).toHaveNoViolations();
  });

  it('confirming a vote hands the toast layer an announceable title and message', async () => {
    render(<ProposalDetailPage />);
    const againstButton = await screen.findByRole('button', { name: /Against/i });
    fireEvent.click(againstButton);

    const confirmButton = await screen.findByRole('button', { name: /Confirm Vote/i });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(mockExecute).toHaveBeenCalled());
    const [, options] = mockExecute.mock.calls[0];
    expect(options.successTitle).toBeTruthy();
    expect(options.successMessage.toLowerCase()).toContain('against');
  });
});
