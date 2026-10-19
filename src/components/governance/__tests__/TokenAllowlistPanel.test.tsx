import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import TokenAllowlistPanel from '../TokenAllowlistPanel';

const ADMIN_ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const VALID_TOKEN_ADDRESS = 'C' + 'B'.repeat(55);

const acceptedTokens = [
  {
    address: 'CUSDCUSDCUSDCUSDCUSDCUSDCUSDCUSDCUSDCUSDCUSDCUSDCUSDCUSD',
    name: 'USD Coin',
    symbol: 'USDC',
  },
  {
    address: 'CEURCEURCEURCEURCEURCEURCEURCEURCEURCEURCEURCEURCEURCEU',
    name: 'Euro Coin',
    symbol: 'EURC',
  },
];

const walletState = {
  address: ADMIN_ADDRESS as string | null,
  isConnected: true,
  signTx: vi.fn(),
};

const addToastMock = vi.fn(() => 'toast-id');
const updateToastMock = vi.fn();
const fetchProtocolParametersMock = vi.fn();
const createProposalMock = vi.fn();
const parseContractErrorMock = vi.fn(() => null as string | null);

vi.mock('@/context/WalletContext', () => ({
  useWallet: () => walletState,
}));

vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ addToast: addToastMock, updateToast: updateToastMock }),
}));

vi.mock('@/utils/governance', () => ({
  GOVERNANCE_INTEGRATION_STATUS: {
    castVote: { status: 'Stubbed', label: 'Vote casting' },
    delegateVotingPower: { status: 'Stubbed', label: 'Vote delegation' },
    createProposal: { status: 'Stubbed', label: 'Proposal creation' },
    executeProposal: { status: 'Stubbed', label: 'Proposal execution' },
    vetoProposal: { status: 'Stubbed', label: 'Proposal veto' },
    getVotingPower: { status: 'Real', label: 'Voting power lookup' },
    getGovTokenBalance: { status: 'Stubbed', label: 'Token balance lookup' },
    getQuorumThreshold: { status: 'Stubbed', label: 'Quorum threshold lookup' },
    getProposalHistory: { status: 'Stubbed', label: 'Proposal history lookup' },
  },
  fetchProtocolParameters: (...args: unknown[]) => fetchProtocolParametersMock(...args),
  createProposal: (...args: unknown[]) => createProposalMock(...args),
}));

vi.mock('@/lib/contract/errors', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/contract/errors')>('@/lib/contract/errors');
  return {
    ...actual,
    parseContractError: (...args: unknown[]) => parseContractErrorMock(...(args as [unknown])),
  };
});

describe('TokenAllowlistPanel', () => {
  beforeEach(() => {
    walletState.address = ADMIN_ADDRESS;
    walletState.isConnected = true;
    addToastMock.mockClear();
    updateToastMock.mockClear();
    fetchProtocolParametersMock.mockReset();
    fetchProtocolParametersMock.mockResolvedValue({ acceptedTokens });
    createProposalMock.mockReset();
    createProposalMock.mockResolvedValue({ txHash: 'tx-hash-1' });
    parseContractErrorMock.mockReset();
    parseContractErrorMock.mockReturnValue(null);
  });

  it('shows a loading row before tokens resolve', () => {
    fetchProtocolParametersMock.mockReturnValue(new Promise(() => {}));
    render(<TokenAllowlistPanel />);
    expect(screen.getByText('Loading tokens...')).toBeInTheDocument();
  });

  it('lists accepted tokens once loaded, flagging the last one as pending removal', async () => {
    render(<TokenAllowlistPanel />);

    await screen.findByText('USDC');
    expect(screen.getByText('EURC')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Pending removal')).toBeInTheDocument();
    expect(screen.getByText(/pending removal in \d+ days\./)).toBeInTheDocument();
  });

  it('shows a read-only badge and disables controls for non-admin wallets', async () => {
    walletState.address = 'GSOMEONEELSE';
    render(<TokenAllowlistPanel />);
    await screen.findByText('USDC');

    expect(screen.getByText('Read-only')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Token contract address')).toBeDisabled();
    expect(screen.getByText('Add Token')).toBeDisabled();
    expect(screen.getAllByText('Remove Token')[0]).toBeDisabled();
  });

  it('rejects an invalid token address without calling createProposal', async () => {
    render(<TokenAllowlistPanel />);
    await screen.findByText('USDC');

    fireEvent.change(screen.getByPlaceholderText('Token contract address'), {
      target: { value: 'not-a-valid-address' },
    });
    fireEvent.click(screen.getByText('Add Token'));

    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Invalid token address' })
    );
    expect(createProposalMock).not.toHaveBeenCalled();
  });

  it('submits an add-token proposal and clears the form on success', async () => {
    render(<TokenAllowlistPanel />);
    await screen.findByText('USDC');

    fireEvent.change(screen.getByPlaceholderText('Token contract address'), {
      target: { value: VALID_TOKEN_ADDRESS },
    });
    fireEvent.click(screen.getByText('Add Token'));

    await waitFor(() => {
      expect(createProposalMock).toHaveBeenCalledWith(
        expect.objectContaining({ formType: 'AddToken', tokenAddress: VALID_TOKEN_ADDRESS }),
        ADMIN_ADDRESS,
        walletState.signTx
      );
    });
    expect(updateToastMock).toHaveBeenCalledWith(
      'toast-id',
      expect.objectContaining({ type: 'success', title: 'Add-token proposal created' })
    );
    expect(screen.getByPlaceholderText('Token contract address')).toHaveValue('');
  });

  it('maps a known contract error code to its friendly message on add failure', async () => {
    createProposalMock.mockRejectedValue(new Error('raw error'));
    parseContractErrorMock.mockReturnValue('Unauthorized');

    render(<TokenAllowlistPanel />);
    await screen.findByText('USDC');

    fireEvent.change(screen.getByPlaceholderText('Token contract address'), {
      target: { value: VALID_TOKEN_ADDRESS },
    });
    fireEvent.click(screen.getByText('Add Token'));

    await waitFor(() => {
      expect(updateToastMock).toHaveBeenCalledWith(
        'toast-id',
        expect.objectContaining({
          type: 'error',
          title: 'Proposal failed',
          message: 'Your wallet is not authorized to perform this action.',
        })
      );
    });
  });

  it('falls back to the raw error message when the code is unrecognized', async () => {
    createProposalMock.mockRejectedValue(new Error('network unreachable'));

    render(<TokenAllowlistPanel />);
    await screen.findByText('USDC');

    fireEvent.change(screen.getByPlaceholderText('Token contract address'), {
      target: { value: VALID_TOKEN_ADDRESS },
    });
    fireEvent.click(screen.getByText('Add Token'));

    await waitFor(() => {
      expect(updateToastMock).toHaveBeenCalledWith(
        'toast-id',
        expect.objectContaining({ type: 'error', message: 'network unreachable' })
      );
    });
  });

  it('submits a remove-token proposal and marks the row as pending removal', async () => {
    render(<TokenAllowlistPanel />);
    await screen.findByText('USDC');

    fireEvent.click(screen.getAllByText('Remove Token')[0]);

    await waitFor(() => {
      expect(createProposalMock).toHaveBeenCalledWith(
        expect.objectContaining({
          formType: 'RemoveToken',
          removeTokenAddress: acceptedTokens[0].address,
        }),
        ADMIN_ADDRESS,
        walletState.signTx
      );
    });
    expect(updateToastMock).toHaveBeenCalledWith(
      'toast-id',
      expect.objectContaining({ type: 'success', title: 'Remove-token proposal created' })
    );
    await waitFor(() => {
      expect(screen.getAllByText('Pending removal').length).toBe(2);
    });
  });

  it('shows an error toast when the removal proposal fails', async () => {
    createProposalMock.mockRejectedValue(new Error('removal blocked'));

    render(<TokenAllowlistPanel />);
    await screen.findByText('USDC');

    fireEvent.click(screen.getAllByText('Remove Token')[0]);

    await waitFor(() => {
      expect(updateToastMock).toHaveBeenCalledWith(
        'toast-id',
        expect.objectContaining({
          type: 'error',
          title: 'Proposal failed',
          message: 'removal blocked',
        })
      );
    });
  });
});
