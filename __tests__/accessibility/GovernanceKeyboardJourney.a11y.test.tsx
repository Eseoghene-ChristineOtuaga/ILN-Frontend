/**
 * Keyboard-only governance voting journey gate (#1126).
 *
 * Walks the real vote confirmation flow (VoteSection -> ProposalDetailPage)
 * using only keyboard input, the way a keyboard-only or switch-device user
 * would. Reuses the mocking setup from GovernanceProposalDetailPage.test.tsx.
 *
 * This is also the regression test for a real bug found while writing this
 * suite: the confirm-vote dialog listened for `Enter` on `window` rather
 * than scoping it to the dialog, so pressing Enter on *any* focused element
 * anywhere on the page while the dialog happened to be open would silently
 * cast an irreversible vote. See VoteSection.tsx's keydown handler.
 */
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, beforeEach, expect } from 'vitest';
import ProposalDetailPage from '../../app/governance/[id]/page';
import { useWallet } from '@/context/WalletContext';
import { useTransaction } from '@/hooks/useTransaction';
import { useToast } from '@/context/ToastContext';
import { fetchProposal } from '@/utils/governance';

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

vi.mock('@/utils/governance', async () => {
  const actual = await vi.importActual<typeof import('@/utils/governance')>('@/utils/governance');
  return {
    ...actual,
    fetchProposal: vi.fn(),
    executeProposal: vi.fn(),
  };
});

const mockUseWallet = useWallet as unknown as vi.Mock;
const mockUseTransaction = useTransaction as unknown as vi.Mock;
const mockUseToast = useToast as unknown as vi.Mock;
const mockFetchProposal = fetchProposal as unknown as vi.Mock;
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
});

describe('Keyboard governance voting journey (#1126)', () => {
  it('opens the confirm dialog with Enter, moves focus into it, and confirms with Enter', async () => {
    const user = userEvent.setup();
    render(<ProposalDetailPage />);

    const againstButton = await screen.findByRole('button', { name: /Against/i });
    againstButton.focus();
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog', { name: /Confirm Vote/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    // Focus moved into the dialog rather than staying on the (now covered)
    // trigger button.
    const cancelButton = screen.getByRole('button', { name: 'Cancel' });
    expect(document.activeElement).toBe(cancelButton);

    await user.keyboard('{Enter}');
    expect(mockExecute).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('closes the dialog with Escape from anywhere and casts no vote', async () => {
    render(<ProposalDetailPage />);

    const forButton = await screen.findByRole('button', { name: /^For$/i });
    forButton.focus();
    fireEvent.click(forButton);
    await screen.findByRole('dialog');

    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(mockExecute).not.toHaveBeenCalled();
    // Focus returns to the control that opened the dialog.
    expect(document.activeElement).toBe(forButton);
  });

  it('regression: Enter on a control outside the dialog no longer casts the pending vote', async () => {
    render(<ProposalDetailPage />);

    const againstButton = await screen.findByRole('button', { name: /Against/i });
    fireEvent.click(againstButton);
    await screen.findByRole('dialog');

    // Move focus to something outside the dialog while it's still open
    // (e.g. a nav link in the page chrome), then press Enter there.
    const outsideLink = screen.getAllByRole('link')[0];
    outsideLink.focus();
    fireEvent.keyDown(window, { key: 'Enter' });

    expect(mockExecute).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('traps Tab within the dialog so focus cannot escape to the page behind it', async () => {
    const user = userEvent.setup();
    render(<ProposalDetailPage />);

    const forButton = await screen.findByRole('button', { name: /^For$/i });
    fireEvent.click(forButton);
    const dialog = await screen.findByRole('dialog');

    const focusable = dialog.querySelectorAll('button');
    const last = focusable[focusable.length - 1] as HTMLElement;
    last.focus();

    // Tab forward from the last element should wrap to the first, not leave the dialog.
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
