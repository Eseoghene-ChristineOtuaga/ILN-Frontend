import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import NewGovernanceProposalPage from '../app/governance/new/page.tsx';
import { useRouter } from 'next/navigation';
import { useWallet } from '@/context/WalletContext';
import { useTransaction } from '@/hooks/useTransaction';
import { useBalances } from '@/hooks/useBalances';
import { fetchProtocolParameters, createProposal, lookupToken } from '@/utils/governance';

// Mock useRouter
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
  })),
}));

// Mock useWallet
vi.mock('@/context/WalletContext', () => ({
  useWallet: vi.fn(() => ({
    address: 'G...MOCK',
    isConnected: true,
    signTx: vi.fn(),
  })),
}));

// Mock useTransaction
vi.mock('@/hooks/useTransaction', () => ({
  useTransaction: vi.fn(() => ({
    execute: vi.fn().mockResolvedValue('txHash123'),
    loading: false,
    error: null,
  })),
}));

// Mock useBalances
vi.mock('@/hooks/useBalances', () => ({
  useBalances: vi.fn(() => ({
    balances: [],
    loading: false,
    error: null,
  })),
}));

// Mock governance utilities
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
  fetchProtocolParameters: vi.fn().mockResolvedValue({
    feeRateBps: 50,
    maxDiscountRateBps: 500,
    acceptedTokens: [
      { address: 'TOKEN1_ADDR', name: 'Token One', symbol: 'TKO' },
      { address: 'TOKEN2_ADDR', name: 'Token Two', symbol: 'TTW' },
    ],
    minProposalILN: 500,
  }),
  createProposal: vi.fn().mockResolvedValue({ txHash: 'mockTx', proposalId: 1 }),
  isValidStellarAddress: vi.fn().mockReturnValue(true),
  lookupToken: vi
    .fn()
    .mockResolvedValue({ address: 'NEW_TOKEN_ADDR', name: 'New Token', symbol: 'NEW' }),
}));

describe('NewGovernanceProposalPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (useRouter as unknown as vi.Mock).mockReturnValue({
      push: vi.fn(),
    });
    (useWallet as unknown as vi.Mock).mockReturnValue({
      address: 'G...MOCK',
      isConnected: true,
      signTx: vi.fn(),
    });
    (useTransaction as unknown as vi.Mock).mockReturnValue({
      // The page now submits the proposal through `execute` so it is signed by
      // the connected wallet (#1044, #1045). The mock therefore has to run the
      // operation it is handed, passing a signTx stub, rather than resolving a
      // canned value — otherwise createProposal would never be reached.
      execute: vi.fn(async (operation: unknown) =>
        typeof operation === 'function'
          ? await (operation as (signTx: (xdr: string) => Promise<string>) => Promise<unknown>)(
              async (xdr: string) => `signed-${xdr}`
            )
          : 'txHash123'
      ),
      loading: false,
      error: null,
      signingModal: null,
    });
    (useBalances as unknown as vi.Mock).mockReturnValue({
      balances: [],
      loading: false,
      error: null,
    });
    (fetchProtocolParameters as vi.Mock).mockResolvedValue({
      feeRateBps: 50,
      maxDiscountRateBps: 500,
      acceptedTokens: [
        { address: 'TOKEN1_ADDR', name: 'Token One', symbol: 'TKO' },
        { address: 'TOKEN2_ADDR', name: 'Token Two', symbol: 'TTW' },
      ],
      minProposalILN: 500,
    });
    (createProposal as vi.Mock).mockResolvedValue({ txHash: 'mockTx', proposalId: 1 });
    (lookupToken as vi.Mock).mockResolvedValue({
      address: 'NEW_TOKEN_ADDR',
      name: 'New Token',
      symbol: 'NEW',
    });
    (useWallet as unknown as vi.Mock).mockImplementation(() => ({
      address: 'G...MOCK',
      isConnected: true,
      signTx: vi.fn(),
    }));
  });

  it('renders the form correctly', async () => {
    render(<NewGovernanceProposalPage />);
    await waitFor(() => {
      expect(screen.getByText(/Create New Governance Proposal/)).toBeDefined();
    });
    expect(screen.getByText(/Not yet live/i)).toBeDefined();
    expect(screen.getByLabelText(/Action Type/)).toBeDefined();
    expect(screen.getByLabelText(/Title/)).toBeDefined();
    expect(screen.getByLabelText(/Description/)).toBeDefined();
    expect(screen.getByRole('button', { name: /Submit Proposal/ })).toBeDefined();
  });

  it('shows dynamic fields based on action type', async () => {
    render(<NewGovernanceProposalPage />);
    await waitFor(() => {
      expect(screen.getByText(/Create New Governance Proposal/)).toBeDefined();
    });

    const select = screen.getByLabelText(/Action Type/);

    fireEvent.change(select, { target: { value: 'FeeRate' } });
    expect(screen.getByLabelText(/Proposed Value \(Basis Points\)/)).toBeDefined();

    fireEvent.change(select, { target: { value: 'AddToken' } });
    expect(screen.getByLabelText(/Token Address \(G...\)/)).toBeDefined();

    fireEvent.change(select, { target: { value: 'RemoveToken' } });
    expect(screen.getByLabelText(/Token to Remove/)).toBeDefined();
  });

  it('disables submit button if balance is insufficient', async () => {
    (useWallet as unknown as vi.Mock).mockReturnValue({
      address: 'G...MOCK',
      isConnected: true,
      signTx: vi.fn(),
    });
    (useBalances as unknown as vi.Mock).mockReturnValue({
      balances: [], // Mocking an empty balance array for now, ILN balance is mocked in the component
      loading: false,
      error: null,
    });
    (fetchProtocolParameters as vi.Mock).mockResolvedValue({
      feeRateBps: 50,
      maxDiscountRateBps: 500,
      acceptedTokens: [],
      minProposalILN: 2000, // Higher minimum balance
    });

    render(<NewGovernanceProposalPage />);
    await waitFor(() => {
      expect(
        screen.getByText(/Your current ILN balance \(1250\) is below the minimum required/)
      ).toBeDefined();
    });
    expect(screen.getByRole('button', { name: /Submit Proposal/ })).toBeDisabled();
  });

  it('shows validation errors for empty required fields', async () => {
    render(<NewGovernanceProposalPage />);
    await waitFor(() => {
      expect(screen.getByText(/Create New Governance Proposal/)).toBeDefined();
    });

    // Submission is blocked up-front while any required field is empty.
    const submitButton = screen.getByRole('button', { name: /Submit Proposal/ });
    expect(submitButton).toBeDisabled();

    fireEvent.click(submitButton);
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('shows live preview with correct values', async () => {
    render(<NewGovernanceProposalPage />);
    await waitFor(() => {
      expect(screen.getByText(/Create New Governance Proposal/)).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/Action Type/), { target: { value: 'FeeRate' } });
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Test Title' } });
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: 'Test Description' },
    });
    fireEvent.change(screen.getByLabelText(/Proposed Value \(Basis Points\)/), {
      target: { value: '100' },
    });

    // The sentence is split across <span>s, so assert on the preview block.
    await waitFor(() => {
      expect(screen.getByText(/This proposal will change/i)).toHaveTextContent(
        'This proposal will change [FeeRate] from 50 (0.5%) to 100 (1%).'
      );
    });
  });

  it('submits the form and redirects on success', async () => {
    const mockRouterPush = vi.fn();
    (useRouter as unknown as vi.Mock).mockReturnValue({
      push: mockRouterPush,
    });

    render(<NewGovernanceProposalPage />);
    await waitFor(() => {
      expect(screen.getByText(/Create New Governance Proposal/)).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/Action Type/), { target: { value: 'FeeRate' } });
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Test Title' } });
    fireEvent.change(screen.getByLabelText(/Description/), {
      target: { value: 'Test Description' },
    });
    fireEvent.change(screen.getByLabelText(/Proposed Value \(Basis Points\)/), {
      target: { value: '100' },
    });

    const submitButton = screen.getByRole('button', { name: /Submit Proposal/ });
    fireEvent.click(submitButton);

    await waitFor(() => {
      expect(createProposal).toHaveBeenCalledWith(
        expect.objectContaining({
          formType: 'FeeRate',
          title: 'Test Title',
          description: expect.stringContaining('Test Description'),
          newValueBps: 100,
        }),
        'G...MOCK',
        expect.any(Function)
      );
      expect(mockRouterPush).toHaveBeenCalledWith('/governance/1');
    });
  });
});
