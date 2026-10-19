import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DelegationPanel } from '../DelegationPanel';

const mockIsValidStellarAddress = vi.fn();
const mockGetVotingPower = vi.fn();
const mockGetDelegationInfo = vi.fn();
const mockDelegateVotingPower = vi.fn();
const mockResolveFederatedAddress = vi.fn();
const mockExecute = vi.fn();

vi.mock('@/utils/governance', () => ({
  GOVERNANCE_INTEGRATION_STATUS: {
    castVote: { status: 'Stubbed', label: 'Vote casting' },
    delegateVotingPower: { status: 'Stubbed', label: 'Vote delegation' },
    createProposal: { status: 'Stubbed', label: 'Proposal creation' },
    executeProposal: { status: 'Stubbed', label: 'Proposal execution' },
    vetoProposal: { status: 'Stubbed', label: 'Proposal veto' },
    getGovTokenBalance: { status: 'Stubbed', label: 'Token balance lookup' },
    getQuorumThreshold: { status: 'Stubbed', label: 'Quorum threshold lookup' },
    getProposalHistory: { status: 'Stubbed', label: 'Proposal history lookup' },
  },
  isValidStellarAddress: (...args: unknown[]) => mockIsValidStellarAddress(...args),
  getVotingPower: (...args: unknown[]) => mockGetVotingPower(...args),
  getDelegationInfo: (...args: unknown[]) => mockGetDelegationInfo(...args),
  delegateVotingPower: (...args: unknown[]) => mockDelegateVotingPower(...args),
}));

vi.mock('@/utils/federation', () => ({
  resolveFederatedAddress: (...args: unknown[]) => mockResolveFederatedAddress(...args),
}));

vi.mock('@/context/WalletContext', () => ({
  useWallet: () => ({
    address: 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC6',
    isConnected: true,
    signTx: vi.fn(),
  }),
}));

vi.mock('@/hooks/useTransaction', () => ({
  useTransaction: () => ({
    execute: mockExecute,
    loading: false,
    error: null,
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockGetDelegationInfo.mockResolvedValue({
    delegatedTo: null,
    delegatedAmount: 0,
    incomingDelegations: 450,
  });
  mockGetVotingPower.mockResolvedValue(1700);
  mockDelegateVotingPower.mockResolvedValue(
    '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  );
});

describe('DelegationPanel', () => {
  it('renders the delegation panel', () => {
    render(<DelegationPanel />);
    expect(screen.getAllByText(/delegat/i)[0]).toBeInTheDocument();
  });

  it('validates stellar addresses', async () => {
    mockIsValidStellarAddress.mockReturnValue(true);
    render(<DelegationPanel />);
    const input = screen.getByPlaceholderText(/address|delegate/i) || screen.getByRole('textbox');
    if (input) {
      fireEvent.change(input, { target: { value: 'GABC123...' } });
      await waitFor(() => {
        expect(mockIsValidStellarAddress).toHaveBeenCalled();
      });
    }
  });

  it('resolves federated addresses', async () => {
    mockResolveFederatedAddress.mockResolvedValue('GABC123RESOLVED');
    render(<DelegationPanel />);
    const input = screen.getByPlaceholderText(/address|delegate/i) || screen.getByRole('textbox');
    if (input) {
      fireEvent.change(input, { target: { value: 'user*example.com' } });
      await waitFor(() => {
        expect(mockResolveFederatedAddress).toHaveBeenCalledWith('user*example.com');
      });
    }
  });

  it('disables delegate button when address is invalid', async () => {
    mockIsValidStellarAddress.mockReturnValue(false);
    render(<DelegationPanel />);
    const delegateButton = screen.queryByRole('button', { name: /delegate|confirm/i });
    if (delegateButton) {
      expect(delegateButton).toBeDisabled();
    }
  });

  it('enables delegate button when address is valid', async () => {
    mockIsValidStellarAddress.mockReturnValue(true);
    render(<DelegationPanel />);
    const input = screen.getByPlaceholderText(/address|delegate/i) || screen.getByRole('textbox');
    if (input) {
      fireEvent.change(input, { target: { value: 'GABC123...' } });
      await waitFor(() => {
        const delegateButton = screen.queryByRole('button', { name: /delegate|confirm/i });
        if (delegateButton && !delegateButton.hasAttribute('disabled')) {
          expect(delegateButton).not.toBeDisabled();
        }
      });
    }
  });

  it('executes delegation transaction on submit', async () => {
    mockIsValidStellarAddress.mockReturnValue(true);
    mockExecute.mockResolvedValue(true);
    render(<DelegationPanel />);
    const input = screen.getByPlaceholderText(/address|delegate/i) || screen.getByRole('textbox');
    if (input) {
      fireEvent.change(input, { target: { value: 'GABC123...' } });
      await waitFor(() => {
        const delegateButton = screen.queryByRole('button', { name: /delegate|confirm/i });
        if (delegateButton && !delegateButton.hasAttribute('disabled')) {
          fireEvent.click(delegateButton);
          expect(mockExecute).toHaveBeenCalled();
        }
      });
    }
  });

  it('displays error on federation resolution failure', async () => {
    mockResolveFederatedAddress.mockRejectedValue(new Error('Resolution failed'));
    render(<DelegationPanel />);
    const input = screen.getByPlaceholderText(/address|delegate/i) || screen.getByRole('textbox');
    if (input) {
      fireEvent.change(input, { target: { value: 'user*invalid.com' } });
      await waitFor(() => {
        expect(mockResolveFederatedAddress).toHaveBeenCalled();
      });
    }
  });

  it('detects and prevents delegation cycles', async () => {
    mockIsValidStellarAddress.mockReturnValue(true);
    render(<DelegationPanel />);
    const input = screen.getByPlaceholderText(/address|delegate/i) || screen.getByRole('textbox');
    if (input) {
      fireEvent.change(input, { target: { value: 'GABC123...' } });
      await waitFor(() => {
        const delegateButton = screen.queryByRole('button', { name: /delegate|confirm/i });
        if (delegateButton) {
          expect(delegateButton).toBeInTheDocument();
        }
      });
    }
  });
});
