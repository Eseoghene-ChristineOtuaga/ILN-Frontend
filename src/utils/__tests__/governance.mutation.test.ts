/**
 * @file governance.mutation.test.ts
 *
 * Focused mutation-testing suite for the governance write paths
 * (src/utils/governance.ts). Per issue #741 the financially-consequential
 * vote-casting and proposal-creation paths are held to a higher
 * mutation-score bar than the app-wide baseline.
 *
 * Since #1044/#1045 these paths are real signed Soroban transactions, so what
 * this suite pins down has changed shape. It no longer asserts that a vote
 * increments a local tally — it asserts the opposite, because a local tally
 * was the fabricated behaviour those issues removed:
 *
 *  - every mutation reaches the contract boundary (simulate → sign → submit →
 *    confirm) and returns the network's own transaction hash;
 *  - **no mutation writes to MOCK_PROPOSALS**, so a confirmed write can never
 *    disagree with on-chain state, and an unconfirmed one can never leave a
 *    phantom vote behind;
 *  - an unconfigured deployment refuses the write outright rather than
 *    falling back to mutating local state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const CONFIGURED_CONTRACT = 'CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC';

// Governance writes require an explicitly configured contract. Suites that
// exercise the real path mock it on; the "unconfigured" suite below imports a
// separate module instance with it off.
vi.mock('@/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/constants')>();
  return {
    ...actual,
    GOVERNANCE_CONTRACT_CONFIGURED: true,
    GOVERNANCE_CONTRACT_ID: 'CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC',
  };
});

import {
  castVote,
  createProposal,
  executeProposal,
  fetchProposal,
  fetchProposals,
  getVetoHistory,
  getVotingPower,
  vetoProposal,
  clearGovernanceIdempotencyCache,
  MOCK_PROPOSALS,
  type CreateProposalPayload,
} from '../governance';
import {
  createGovernanceRpcStub,
  governanceWriteOptions,
  passthroughSignTx,
} from '@/test-utils/governance-rpc';

// A real strkey: the pipeline encodes it with `Address.fromString`, which
// validates the checksum, so a placeholder string will not do.
const SIGNER = 'GD2HBFZSXTH4UCKZUVME665WBIPLRBPDTOTYWFRBCKZSFTP7PK46JYSK';

/** Snapshot of every field a mock mutation used to touch. */
function snapshotMockState() {
  return MOCK_PROPOSALS.map((p) => ({
    id: p.id,
    status: p.status,
    votesFor: p.votesFor,
    votesAgainst: p.votesAgainst,
    votesAbstain: p.votesAbstain,
    vetoHistory: p.vetoHistory?.length ?? 0,
  }));
}

beforeEach(async () => {
  clearGovernanceIdempotencyCache();
  vi.clearAllMocks();
  // The proposal *read* path is not under test here; stub it offline so
  // `fetchProposals` takes its MOCK_PROPOSALS fallback without a real
  // network round-trip.
  const { rpc } = await import('@stellar/stellar-sdk');
  vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockRejectedValue(new Error('offline'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('governance.castVote (critical path)', () => {
  it('returns the hash the network issued, not a locally derived one', async () => {
    const stub = createGovernanceRpcStub();
    const signTx = passthroughSignTx();

    const hash = await castVote(1, 'For', SIGNER, signTx, governanceWriteOptions(stub));

    expect(hash).toBe(stub.issuedHashes[0]);
    expect(stub.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(signTx).toHaveBeenCalledTimes(1);
    expect(stub.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('simulates before requesting the signature', async () => {
    const stub = createGovernanceRpcStub();
    const order: string[] = [];
    stub.simulateTransaction.mockImplementation(async () => {
      order.push('simulate');
      const { governanceSimulationSuccess } = await import('@/test-utils/governance-rpc');
      return governanceSimulationSuccess();
    });
    const signTx = passthroughSignTx(() => order.push('sign'));

    await castVote(1, 'For', SIGNER, signTx, governanceWriteOptions(stub));

    expect(order).toEqual(['simulate', 'sign']);
  });

  it('records the confirmed vote choice without touching the proposal tally', async () => {
    const stub = createGovernanceRpcStub();
    const before = await fetchProposal(1);

    await castVote(1, 'For', SIGNER, passthroughSignTx(), governanceWriteOptions(stub));

    const after = await fetchProposal(1);
    expect(after?.userVote).toBe('For');
    // The tally is contract-owned: a local increment is exactly the
    // fabricated behaviour #1044/#1045 removed.
    expect(after?.votesFor).toBe(before?.votesFor);
    expect(after?.votesAgainst).toBe(before?.votesAgainst);
  });

  it.each(['For', 'Against'] as const)(
    'leaves every MOCK_PROPOSALS tally untouched when voting %s',
    async (choice) => {
      const stub = createGovernanceRpcStub();
      const before = snapshotMockState();

      await castVote(2, choice, SIGNER, passthroughSignTx(), governanceWriteOptions(stub));

      expect(snapshotMockState()).toEqual(before);
    }
  );

  it('rejects a write with no connected wallet instead of returning a hash', async () => {
    const stub = createGovernanceRpcStub();

    await expect(
      castVote(1, 'For', '', passthroughSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/SOURCE_ACCOUNT_MISSING/);
    // The old mock path accepted an empty signer and invented a hash.
    expect(stub.sendTransaction).not.toHaveBeenCalled();
  });

  it('rejects a malformed wallet address before any network call', async () => {
    const stub = createGovernanceRpcStub();

    await expect(
      castVote(1, 'For', 'not-an-address', passthroughSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/not a valid Stellar address/);
    expect(stub.getAccount).not.toHaveBeenCalled();
  });

  it('does not record a vote when the transaction fails on-chain', async () => {
    const stub = createGovernanceRpcStub({ confirmation: 'failed' });
    const before = await fetchProposal(6);

    await expect(
      castVote(6, 'For', SIGNER, passthroughSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/TX_FAILED/);

    const after = await fetchProposal(6);
    expect(after?.userVote).toBe(before?.userVote);
    expect(snapshotMockState()).toEqual(snapshotMockState());
  });

  it('does not record a vote when confirmation times out', async () => {
    // An unknown outcome must not be recorded as a vote: the UI would show a
    // vote that may never have landed (#1045).
    const stub = createGovernanceRpcStub({ confirmation: 'never' });

    await expect(
      castVote(7, 'For', SIGNER, passthroughSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/TX_TIMEOUT/);

    expect((await fetchProposal(7))?.userVote).toBeUndefined();
  });
});

describe('governance.createProposal (critical path)', () => {
  const payload: CreateProposalPayload = {
    formType: 'FeeRate',
    title: 'Reduce the protocol fee',
    description: 'Testing the real create_proposal path.',
    newValueBps: 40,
  };

  it('returns the proposal id the contract assigned', async () => {
    const stub = createGovernanceRpcStub({ proposalId: 512 });

    const result = await createProposal(
      payload,
      SIGNER,
      passthroughSignTx(),
      governanceWriteOptions(stub)
    );

    expect(result.proposalId).toBe(512);
    expect(result.txHash).toBe(stub.issuedHashes[0]);
  });

  it('appends nothing to MOCK_PROPOSALS', async () => {
    const stub = createGovernanceRpcStub();
    const beforeCount = MOCK_PROPOSALS.length;
    const beforeFetched = (await fetchProposals()).length;

    await createProposal(payload, SIGNER, passthroughSignTx(), governanceWriteOptions(stub));

    // The old path pushed a locally built proposal with an invented id.
    expect(MOCK_PROPOSALS.length).toBe(beforeCount);
    expect((await fetchProposals()).length).toBe(beforeFetched);
  });

  it.each([
    ['FeeRate', { formType: 'FeeRate', newValueBps: 40 }],
    ['MaxDiscountRate', { formType: 'MaxDiscountRate', newValueBps: 450 }],
    ['AddToken', { formType: 'AddToken', tokenAddress: CONFIGURED_CONTRACT }],
    ['RemoveToken', { formType: 'RemoveToken', removeTokenAddress: CONFIGURED_CONTRACT }],
  ] as const)('submits a %s proposal through the contract boundary', async (_name, partial) => {
    const stub = createGovernanceRpcStub();

    await createProposal(
      { title: 'T', description: 'D', ...partial } as CreateProposalPayload,
      SIGNER,
      passthroughSignTx(),
      governanceWriteOptions(stub)
    );

    expect(stub.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['FeeRate', { formType: 'FeeRate' }, /newValueBps/],
    ['MaxDiscountRate', { formType: 'MaxDiscountRate' }, /newValueBps/],
    ['AddToken', { formType: 'AddToken' }, /tokenAddress/],
    ['RemoveToken', { formType: 'RemoveToken' }, /removeTokenAddress/],
  ] as const)(
    'refuses an incomplete %s payload before signing',
    async (_name, partial, expected) => {
      const stub = createGovernanceRpcStub();
      const signTx = passthroughSignTx();

      await expect(
        createProposal(
          { title: 'T', description: 'D', ...partial } as CreateProposalPayload,
          SIGNER,
          signTx,
          governanceWriteOptions(stub)
        )
      ).rejects.toThrow(expected);
      expect(signTx).not.toHaveBeenCalled();
    }
  );

  it('fails loudly when a confirmed create returns no usable proposal id', async () => {
    // The transaction landed, so inventing an id here would misreport which
    // proposal was created.
    const stub = createGovernanceRpcStub();
    stub.getTransaction.mockResolvedValue({
      status: (await import('@stellar/stellar-sdk')).rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 1,
    });

    await expect(
      createProposal(payload, SIGNER, passthroughSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/returned no proposal id/);
  });
});

describe('governance.executeProposal / vetoProposal', () => {
  it('executes through the contract without setting the status locally', async () => {
    const stub = createGovernanceRpcStub();
    const before = await fetchProposal(3);

    const hash = await executeProposal(
      3,
      SIGNER,
      passthroughSignTx(),
      governanceWriteOptions(stub)
    );

    expect(hash).toBe(stub.issuedHashes[0]);
    // Status is re-read from the contract, never written locally.
    expect((await fetchProposal(3))?.status).toBe(before?.status);
  });

  it('records a veto only after the network confirms it', async () => {
    const stub = createGovernanceRpcStub();

    const hash = await vetoProposal(
      4,
      '0xreason',
      SIGNER,
      passthroughSignTx(),
      governanceWriteOptions(stub)
    );

    expect(hash).toBe(stub.issuedHashes[0]);
    expect(getVetoHistory(4)).toHaveLength(1);
    expect(getVetoHistory(4)[0]).toMatchObject({ proposalId: 4, admin: SIGNER });
  });

  it('adds no veto record when the veto times out', async () => {
    const stub = createGovernanceRpcStub({ confirmation: 'never' });

    await expect(
      vetoProposal(5, '0xreason', SIGNER, passthroughSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/TX_TIMEOUT/);

    expect(getVetoHistory(5)).toHaveLength(0);
  });

  it('does not set a proposal status to Vetoed in MOCK_PROPOSALS', async () => {
    const stub = createGovernanceRpcStub();
    const statusesBefore = MOCK_PROPOSALS.map((p) => p.status);

    await vetoProposal(6, '0xreason-2', SIGNER, passthroughSignTx(), governanceWriteOptions(stub));

    expect(MOCK_PROPOSALS.map((p) => p.status)).toEqual(statusesBefore);
  });
});

describe('governance.getVotingPower', () => {
  it('reports zero rather than a fabricated constant when the read fails', async () => {
    const { rpc } = await import('@stellar/stellar-sdk');
    vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockRejectedValue(new Error('offline'));

    await expect(getVotingPower(SIGNER)).resolves.toBe(0);
  });
});
