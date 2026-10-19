import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import NewGovernanceProposalPage from '../app/governance/new/page.tsx';
import { useRouter } from 'next/navigation';
import { useWallet } from '@/context/WalletContext';
import {
  ChainParametersError,
  CreateProposalError,
  createProposal,
  fetchProposerBalance,
  fetchProtocolParameters,
  type ProtocolParameters,
} from '@/utils/governance';

vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ push: vi.fn() })),
}));

vi.mock('@/context/WalletContext', () => ({
  useWallet: vi.fn(),
}));

// Keep the real schema validation (#1056) and only replace network reads/writes.
vi.mock('@/utils/governance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/governance')>()),
  fetchProtocolParameters: vi.fn(),
  fetchProposerBalance: vi.fn(),
  createProposal: vi.fn(),
  lookupToken: vi.fn(),
  simulateProposalEffect: vi.fn().mockResolvedValue({
    isContractVerified: false,
    estimatedEffect: 'estimate',
  }),
}));

const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const DESCRIPTION = 'Lower protocol fees so LP returns stay competitive.';
const signTx = vi.fn();

function params(overrides: Partial<ProtocolParameters> = {}): ProtocolParameters {
  return {
    feeRateBps: 50,
    maxDiscountRateBps: 500,
    acceptedTokens: [
      {
        address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
        name: 'USD Coin',
        symbol: 'USDC',
        decimals: 7,
      },
    ],
    minProposalBalance: 500_0000000n,
    minProposalDeposit: 100_0000000n,
    minProposalILN: 500,
    quorumThresholdBps: 1_000,
    govTokenTotalSupply: 1_000_000_0000000n,
    govTokenDecimals: 7,
    feeRateRange: { min: 0, max: 10_000 },
    maxDiscountRateRange: { min: 1, max: 5_000 },
    unconfirmed: [],
    ...overrides,
  };
}

async function renderLoaded() {
  render(<NewGovernanceProposalPage />);
  await waitFor(() => expect(screen.getByText(/Create New Governance Proposal/)).toBeDefined());
}

function fillFeeRate(value: string, description = DESCRIPTION) {
  fireEvent.change(screen.getByLabelText(/Action Type/), { target: { value: 'FeeRate' } });
  fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Test Title' } });
  fireEvent.change(screen.getByLabelText(/Description/), { target: { value: description } });
  fireEvent.change(screen.getByLabelText(/Proposed Value \(Basis Points\)/), {
    target: { value },
  });
}

async function submitReady() {
  const submit = screen.getByRole('button', { name: /Submit Proposal/ });
  await waitFor(() => expect(submit).not.toBeDisabled());
  fireEvent.click(submit);
}

describe('NewGovernanceProposalPage', () => {
  let push: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    push = vi.fn();
    (useRouter as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ push });
    (useWallet as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      address: ADDRESS,
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
      signTx,
    });
    vi.mocked(fetchProtocolParameters).mockResolvedValue(params());
    vi.mocked(fetchProposerBalance).mockResolvedValue(1_250_0000000n);
    vi.mocked(createProposal).mockResolvedValue({ txHash: 'ab'.repeat(32), proposalId: 1 });
  });

  it('renders the form correctly', async () => {
    await renderLoaded();
    expect(screen.getByText(/Not yet live/i)).toBeDefined();
    expect(screen.getByLabelText(/Action Type/)).toBeDefined();
    expect(screen.getByLabelText(/Title/)).toBeDefined();
    expect(screen.getByLabelText(/Description/)).toBeDefined();
    expect(screen.getByRole('button', { name: /Submit Proposal/ })).toBeDefined();
  });

  it('shows dynamic fields based on action type, with chain-derived ranges', async () => {
    await renderLoaded();
    const select = screen.getByLabelText(/Action Type/);

    fireEvent.change(select, { target: { value: 'FeeRate' } });
    expect(screen.getByLabelText(/Proposed Value \(Basis Points\)/)).toBeDefined();
    expect(screen.getByPlaceholderText(/\(0-10000\)/)).toBeDefined();

    fireEvent.change(select, { target: { value: 'MaxDiscountRate' } });
    expect(screen.getByPlaceholderText(/\(1-5000\)/)).toBeDefined();

    fireEvent.change(select, { target: { value: 'AddToken' } });
    expect(screen.getByLabelText(/Token Address \(C...\)/)).toBeDefined();

    fireEvent.change(select, { target: { value: 'RemoveToken' } });
    expect(screen.getByLabelText(/Token to Remove/)).toBeDefined();
  });

  it('uses the on-chain ILN balance and gate, and disables submit when insufficient', async () => {
    vi.mocked(fetchProposerBalance).mockResolvedValue(100_0000000n);
    await renderLoaded();

    await waitFor(() =>
      expect(
        screen.getByText(/Your current ILN balance \(100\) is below the minimum required/)
      ).toHaveTextContent('(500)')
    );
    expect(fetchProposerBalance).toHaveBeenCalledWith(ADDRESS);
    expect(screen.getByRole('button', { name: /Submit Proposal/ })).toBeDisabled();
  });

  it('reports an unreadable balance instead of assuming one', async () => {
    vi.mocked(fetchProposerBalance).mockRejectedValue(
      new Error('Could not read your ILN balance from the network.')
    );
    await renderLoaded();
    fillFeeRate('100');

    expect(await screen.findByText(/Could not read your ILN balance/)).toBeDefined();
    expect(screen.getByRole('button', { name: /Submit Proposal/ })).toBeDisabled();
  });

  it('shows an explicit, retryable error when chain parameters cannot be read', async () => {
    vi.mocked(fetchProtocolParameters)
      .mockRejectedValueOnce(new ChainParametersError(['quorumThresholdBps']))
      .mockResolvedValueOnce(params());
    await renderLoaded();

    expect(screen.getByRole('alert')).toHaveTextContent(
      /could not be read from the network \(quorumThresholdBps\)/
    );
    fillFeeRate('100');
    expect(screen.getByRole('button', { name: /Submit Proposal/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchProtocolParameters).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText(/quorumThresholdBps/)).toBeNull());
  });

  it('blocks submission while required fields are empty', async () => {
    await renderLoaded();
    const submitButton = screen.getByRole('button', { name: /Submit Proposal/ });
    expect(submitButton).toBeDisabled();
    fireEvent.click(submitButton);
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('validates against the chain range and the confirmed current value', async () => {
    await renderLoaded();
    fireEvent.change(screen.getByLabelText(/Action Type/), {
      target: { value: 'MaxDiscountRate' },
    });
    fireEvent.change(screen.getByLabelText(/Title/), { target: { value: 'Raise discount' } });
    fireEvent.change(screen.getByLabelText(/Description/), { target: { value: DESCRIPTION } });
    const input = screen.getByLabelText(/Proposed Value \(Basis Points\)/);

    fireEvent.change(input, { target: { value: '6000' } });
    fireEvent.blur(input);
    expect(
      await screen.findByText('Maximum discount rate must be between 1 and 5000 basis points.')
    ).toHaveAttribute('id', 'newValueBps-error');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    fireEvent.change(input, { target: { value: '500' } });
    fireEvent.blur(input);
    expect(
      await screen.findByText('Maximum discount rate is already 500 basis points.')
    ).toBeDefined();
  });

  it('shows live preview with correct values', async () => {
    await renderLoaded();
    fillFeeRate('100');
    await waitFor(() => {
      expect(screen.getByText(/This proposal will change/i)).toHaveTextContent(
        'This proposal will change [FeeRate] from 50 (0.5%) to 100 (1%).'
      );
    });
  });

  it('does not invent a current value that is not confirmed on-chain', async () => {
    vi.mocked(fetchProtocolParameters).mockResolvedValue(
      params({ feeRateBps: null, unconfirmed: ['feeRateBps'] })
    );
    await renderLoaded();
    fillFeeRate('100');
    await waitFor(() => {
      expect(screen.getByText(/This proposal will change/i)).toHaveTextContent(
        'from its current value (not confirmed on-chain) to 100 (1%).'
      );
    });
  });

  it('submits through the wallet signer and redirects to the on-chain proposal id', async () => {
    await renderLoaded();
    fillFeeRate('100');
    await submitReady();

    await waitFor(() => {
      expect(createProposal).toHaveBeenCalledWith(
        expect.objectContaining({
          formType: 'FeeRate',
          title: 'Test Title',
          description: DESCRIPTION,
          newValueBps: 100,
        }),
        ADDRESS,
        signTx,
        expect.objectContaining({
          context: expect.objectContaining({ currentFeeRateBps: 50 }),
          onStage: expect.any(Function),
        })
      );
      expect(push).toHaveBeenCalledWith('/governance/1');
    });
    // No placeholder IPFS hash is appended to the committed description.
    expect(vi.mocked(createProposal).mock.calls[0][0].description).not.toMatch(/IPFS/);
  });

  it('announces transaction stages in a live region', async () => {
    vi.mocked(createProposal).mockImplementation(async (_p, _a, _s, options) => {
      options?.onStage?.('awaiting_signature');
      return new Promise(() => {});
    });
    await renderLoaded();
    fillFeeRate('100');
    await submitReady();

    await waitFor(() =>
      expect(
        screen
          .getAllByRole('status')
          .some((s) => /Waiting for your wallet signature/.test(s.textContent ?? ''))
      ).toBe(true)
    );
  });

  it('shows typed failure states and does not redirect', async () => {
    vi.mocked(createProposal).mockRejectedValue(
      new CreateProposalError('USER_REJECTED', 'awaiting_signature', 'declined')
    );
    await renderLoaded();
    fillFeeRate('100');
    await submitReady();

    expect(
      await screen.findByText('Signature declined in your wallet. No proposal was created.')
    ).toBeDefined();
    expect(push).not.toHaveBeenCalled();
  });

  it('surfaces a confirmation timeout with the transaction hash', async () => {
    const hash = 'cd'.repeat(32);
    vi.mocked(createProposal).mockRejectedValue(
      new CreateProposalError('CONFIRMATION_TIMEOUT', 'confirming', 'pending', { txHash: hash })
    );
    await renderLoaded();
    fillFeeRate('100');
    await submitReady();

    expect(
      await screen.findByText(new RegExp(`${hash} was submitted but is not confirmed`))
    ).toBeDefined();
    expect(push).not.toHaveBeenCalled();
  });
});
