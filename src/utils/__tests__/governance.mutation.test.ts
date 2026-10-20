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
 *  - castVote: For / Against / Abstain tally increments + userVote recording
 *  - createProposal: signed `create_proposal` for FeeRate / MaxDiscountRate /
 *    AddToken / RemoveToken, with no local proposal mutation (#1055)
 *  - vetoProposal: success + "Proposal not found" guard
 *  - executeProposal / getVotingPower happy paths
 *
 * #1070 additions:
 *  - signTx is asserted called with the correct intent string on every write path
 *  - every returned hash must satisfy isValidTxHash (64-char hex)
 *  - hash is deterministic: same inputs → same hash across two independent calls
 *  - regression guard: no unsigned:/random fallback when a real signer is present
 *
 * The module keeps mutable mock state (MOCK_PROPOSALS, userVotes, vetoHistory)
 * at module scope, and Vitest isolates modules per test file, so assertions
 * are written relative to fetched-before/after snapshots rather than absolute
 * counters.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  castVote,
  createProposal,
  executeProposal,
  clearGovernanceIdempotencyCache,
  fetchProposal,
  fetchProposals,
  getVetoHistory,
  getVotingPower,
  VotingPowerError,
  GovernanceNetworkMismatchError,
  GovernanceReadError,
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
  decodeProposalCreatedEvent,
  decodeProposalExecutedEvent,
  decodeVoteCastEvent,
  decodeProposalVetoedEvent,
  decodeParameterUpdatedEvent,
  decodeGovernanceEvent,
  createProposalCreatedFixture,
  createProposalExecutedFixture,
  createVoteCastFixture,
  createProposalVetoedFixture,
  createParameterUpdatedFixture,
  EventDecodingError,
  type CreateProposalPayload,
} from '../governance';
import {
  Address,
  scValToNative,
  nativeToScVal,
  rpc,
  Networks,
  TransactionBuilder,
  type Transaction,
} from '@stellar/stellar-sdk';
import { GOVERNANCE_CONTRACT_ID } from '@/constants';
import { isValidTxHash } from '../explorer';
import {
  clearGovernanceTestSession,
  establishGovernanceTestSession,
} from './helpers/governanceSession';
import {
  CREATE_TX_HASH,
  PROPOSAL_CONTEXT,
  PROPOSER,
  USDC_CONTRACT,
  XLM_SAC_CONTRACT,
  passthroughSignTx,
  stubProposalRpc,
} from './helpers/proposalRpc';

afterEach(() => {
  vi.restoreAllMocks();
});
const signTx = vi.fn(async (xdr: string) => `signed-${xdr}`);
const SIGNER = PROPOSER;

// Regression guard: ensures sign, submit and confirm never return a mock-random
// fallback. A hash that starts with "unsigned:" means no wallet was involved,
// which is only acceptable in read-only or test contexts that explicitly pass
// an empty signer. Any hash produced for a real signer must be derived from the
// collected signature — never from Math.random() (#1141).
function assertNoRandomFallback(hash: string, context: string) {
  expect(hash, `${context}: must not start with 'unsigned:'`).not.toMatch(/^unsigned:/);
  expect(hash, `${context}: must not contain 'random'`).not.toMatch(/random/i);
  expect(
    isValidTxHash(hash),
    `${context}: must be a valid 64-char hex tx hash, got "${hash}"`
  ).toBe(true);
}

// The governance write paths are gated behind a valid SEP-10 session (#1076),
// so every test starts with a deterministic session and tears it down after.
beforeEach(() => {
  establishGovernanceTestSession(SIGNER);
});

afterEach(() => {
  clearGovernanceTestSession();
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
  beforeEach(() => {
    signTx.mockClear();
    clearGovernanceIdempotencyCache();
  });

  it('records a For vote and increments votesFor', async () => {
    const before = await fetchProposal(1);
    const result = await castVote(1, 'For', SIGNER, signTx);

    expect(signTx).toHaveBeenCalledWith(expect.stringContaining('vote:1:For'));
    assertNoRandomFallback(result, 'castVote For');

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
  it('records an Against vote and increments votesAgainst', async () => {
    const before = await fetchProposal(2);
    const result = await castVote(2, 'Against', SIGNER, signTx);

    expect(signTx).toHaveBeenCalledWith(expect.stringContaining('vote:2:Against'));
    assertNoRandomFallback(result, 'castVote Against');

    const after = await fetchProposal(2);
    expect(after?.userVote).toBe('Against');
    if (before && after) {
      expect(after.votesAgainst).toBe(before.votesAgainst + 1250);
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
  it('records an Abstain vote and increments votesAbstain', async () => {
    const before = await fetchProposal(3);
    const result = await castVote(3, 'Abstain', SIGNER, signTx);

    expect(signTx).toHaveBeenCalledWith(expect.stringContaining('vote:3:Abstain'));
    assertNoRandomFallback(result, 'castVote Abstain');

    const after = await fetchProposal(3);
    expect(after?.userVote).toBe('Abstain');
    if (before && after) {
      expect(after.votesAbstain).toBe(before.votesAbstain + 1250);
    }
  });

  it('returns a valid 64-char hex hash even when no signer address is supplied', async () => {
    const result = await castVote(1, 'For', '', signTx);
    expect(isValidTxHash(result)).toBe(true);
  });

  it('hash is deterministic: same vote inputs yield the same hash', async () => {
    const hash1 = await castVote(4, 'For', SIGNER, signTx);
    clearGovernanceIdempotencyCache();
    const hash2 = await castVote(4, 'For', SIGNER, signTx);
    expect(hash1).toBe(hash2);
  });

  it('fails closed and blocks mutation when voting-power read fails (#1049)', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockRejectedValueOnce(new Error('Network transport failure'));

    await expect(castVote(1, 'For', SIGNER, signTx)).rejects.toThrow(/VOTING_POWER_UNAVAILABLE/);
    expect(signTx).not.toHaveBeenCalled();
    mockSimulate.mockRestore();
  });

  it('blocks mutation when voter has zero voting power (#1049)', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValueOnce({
        error: undefined,
        transactionData: {} as any,
        minResourceFee: '100',
        events: [],
        result: { retval: nativeToScVal(0n, { type: 'i128' }) },
      } as any);

    await expect(castVote(1, 'For', SIGNER, signTx)).rejects.toThrow(/VOTING_POWER_UNAVAILABLE/);
    expect(signTx).not.toHaveBeenCalled();
    mockSimulate.mockRestore();
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
  const proposalSignTx = vi.fn(passthroughSignTx);
  let rpcStub: ReturnType<typeof stubProposalRpc>;

  beforeEach(() => {
    proposalSignTx.mockClear();
    clearGovernanceIdempotencyCache();
    establishGovernanceTestSession(PROPOSER);
    rpcStub = stubProposalRpc({ proposalId: 77 });
  });

  afterEach(() => {
    rpcStub.restore();
  });

  /** Decode the `create_proposal` invocation the wallet was asked to sign. */
  function signedInvocation() {
    expect(proposalSignTx).toHaveBeenCalledTimes(1);
    const tx = TransactionBuilder.fromXDR(
      proposalSignTx.mock.calls[0][0],
      Networks.TESTNET
    ) as Transaction;
    const op = tx.operations[0] as unknown as {
      func: {
        invokeContract(): { functionName(): Buffer; args(): Parameters<typeof scValToNative>[0][] };
      };
    };
    const invoke = op.func.invokeContract();
    return {
      fn: invoke.functionName().toString(),
      action: scValToNative(invoke.args()[1]),
      proposedValue: scValToNative(invoke.args()[3]),
    };
  }

  async function create(payload: CreateProposalPayload) {
    const mockBefore = MOCK_PROPOSALS.length;
    const listBefore = (await fetchProposals()).length;
    const res = await createProposal(payload, PROPOSER, proposalSignTx, {
      context: PROPOSAL_CONTEXT,
    });
    // No local proposal is fabricated: the record only exists on-chain.
    expect(MOCK_PROPOSALS.length).toBe(mockBefore);
    expect((await fetchProposals()).length).toBe(listBefore);
    return res;
  }

  it('signs create_proposal(UpdateFeeRate) and returns the id from the chain', async () => {
    const res = await create({
      formType: 'FeeRate',
      title: 'Reduce protocol fee rate',
      description: 'Lower the fee to stay competitive with other pools',
      newValueBps: 30,
    });

    expect(res).toEqual({ txHash: CREATE_TX_HASH, proposalId: 77 });
    assertNoRandomFallback(res.txHash, 'createProposal FeeRate');
    expect(signedInvocation()).toEqual({
      fn: 'create_proposal',
      action: ['UpdateFeeRate', 30],
      proposedValue: 30n,
    });
    expect(rpcStub.sendTransaction).toHaveBeenCalledTimes(1);
    expect(rpcStub.pollTransaction).toHaveBeenCalledWith(CREATE_TX_HASH, expect.anything());
  });

  it('maps MaxDiscountRate to UpdateMaxDiscountRate', async () => {
    await create({
      formType: 'MaxDiscountRate',
      title: 'Raise max discount rate',
      description: 'Allow deeper early-pay discounts for suppliers',
      newValueBps: 400,
    });
    expect(signedInvocation().action).toEqual(['UpdateMaxDiscountRate', 400]);
  });

  it('maps AddToken to AddToken(address, decimals)', async () => {
    await create({
      formType: 'AddToken',
      title: 'List XLM',
      description: 'Add the native asset contract to accepted tokens',
      tokenAddress: XLM_SAC_CONTRACT,
      tokenName: 'XLM',
      tokenDecimals: 7,
    });
    expect(signedInvocation()).toMatchObject({
      action: ['AddToken', XLM_SAC_CONTRACT, 7],
      proposedValue: 0n,
    });
  });

  it('maps RemoveToken to RemoveToken(address)', async () => {
    await create({
      formType: 'RemoveToken',
      title: 'Delist USDC',
      description: 'Remove a deprecated token from accepted tokens',
      removeTokenAddress: USDC_CONTRACT,
    });
    expect(signedInvocation().action).toEqual(['RemoveToken', USDC_CONTRACT]);
  });

  it('rejects schema-invalid payloads before signing', async () => {
    await expect(
      createProposal(
        {
          formType: 'RemoveToken',
          title: 'Delist unknown',
          description: 'Remove a token that is not accepted at all',
          removeTokenAddress: XLM_SAC_CONTRACT,
        },
        PROPOSER,
        proposalSignTx,
        { context: PROPOSAL_CONTEXT }
      )
    ).rejects.toMatchObject({ code: 'PROPOSAL_VALIDATION_FAILED' });
    expect(proposalSignTx).not.toHaveBeenCalled();
    expect(rpcStub.sendTransaction).not.toHaveBeenCalled();
  });

  it('requires a SEP-10 session', async () => {
    clearGovernanceTestSession();
    await expect(
      createProposal(
        {
          formType: 'FeeRate',
          title: 'No session',
          description: 'Should be blocked before any network call',
          newValueBps: 10,
        },
        PROPOSER,
        proposalSignTx,
        { context: PROPOSAL_CONTEXT }
      )
    ).rejects.toThrow(/SEP10_SESSION_REQUIRED/);
    expect(rpcStub.getAccount).not.toHaveBeenCalled();
  });

  it('createProposal hash is deterministic across two independent calls with same payload', async () => {
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Determinism check',
      description: 'Same payload, same signed transaction',
      newValueBps: 50,
    };
    const res1 = await createProposal(payload, PROPOSER, proposalSignTx, {
      context: PROPOSAL_CONTEXT,
    });
    clearGovernanceIdempotencyCache();
    const res2 = await createProposal(payload, PROPOSER, proposalSignTx, {
      context: PROPOSAL_CONTEXT,
    });
    expect(res1.txHash).toBe(res2.txHash);
    expect(proposalSignTx.mock.calls[0][0]).toBe(proposalSignTx.mock.calls[1][0]);
  });
});

describe('governance.vetoProposal', () => {
  beforeEach(() => {
    signTx.mockClear();
    clearGovernanceIdempotencyCache();
  });

  it('vetoes an existing proposal and prepends a veto record', async () => {
    // Proposal creation is on-chain now; veto an existing active proposal.
    const created = { proposalId: 6 };

    const res = await vetoProposal(created.proposalId, '0xreason', SIGNER, signTx);

    expect(signTx).toHaveBeenCalledWith(expect.stringContaining('veto'));
    assertNoRandomFallback(res, 'vetoProposal');

    const after = await fetchProposal(created.proposalId);
    expect(after?.status).toBe('Vetoed');
  });

  it('throws when the proposal does not exist', async () => {
    await expect(vetoProposal(999_999, '0xreason', SIGNER, signTx)).rejects.toThrow(
      /proposal not found/i
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
  it('fails closed with a typed error when voting power read fails (#1049)', async () => {
    const mockSimulate = vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue({
      error: 'Simulation failed: host error',
    } as any);

    await expect(getVotingPower(SIGNER)).rejects.toThrow(VotingPowerError);
    await expect(getVotingPower(SIGNER)).rejects.toThrow(/VOTING_POWER_UNAVAILABLE/);
    mockSimulate.mockRestore();
  });

  it('fails closed when address is missing or invalid (#1049)', async () => {
    await expect(getVotingPower('')).rejects.toThrow(VotingPowerError);
    await expect(getVotingPower('INVALID_ADDR')).rejects.toThrow(VotingPowerError);
  });

  it('queries delegated voting power from governance contract authority (#1048)', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValueOnce({
        error: undefined,
        transactionData: {} as any,
        minResourceFee: '100',
        events: [],
        result: {
          retval: nativeToScVal(2500),
        },
      } as any);

    const power = await getVotingPower(SIGNER);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
    const tx = mockSimulate.mock.calls[0][0] as any;
    const op = tx.operations[0];
    const func = op.func?.invokeContract?.();
    const funcName = func ? func.functionName().toString() : op.function;
    const contract = func ? Address.fromScAddress(func.contractAddress()).toString() : op.contract;
    expect(['invokeHostFunction', 'invokeContractFunction']).toContain(op.type);
    expect(contract).toBe(GOVERNANCE_CONTRACT_ID);
    expect(funcName).toBe('get_voting_power');
    expect(power).toBe(2500);
    mockSimulate.mockRestore();
  });
});

describe('governance write-path regression: no mock/random fallback (#1070)', () => {
  beforeEach(() => {
    signTx.mockClear();
    clearGovernanceIdempotencyCache();
  });

  it('castVote does not return Math.random()-based hash when signer is present', async () => {
    // Call twice; if the implementation used Math.random() the hashes would differ
    const hash1 = await castVote(5, 'For', SIGNER, signTx);
    clearGovernanceIdempotencyCache();
    const hash2 = await castVote(5, 'For', SIGNER, signTx);
    expect(hash1).toBe(hash2);
    assertNoRandomFallback(hash1, 'castVote regression');
  });

  it('createProposal does not return Math.random()-based hash when signer is present', async () => {
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Regression check',
      description: 'No random hashes allowed for proposals',
      newValueBps: 10,
    };
    establishGovernanceTestSession(PROPOSER);
    const rpcStub = stubProposalRpc();
    try {
      const options = { context: PROPOSAL_CONTEXT };
      const res1 = await createProposal(payload, PROPOSER, passthroughSignTx, options);
      clearGovernanceIdempotencyCache();
      const res2 = await createProposal(payload, PROPOSER, passthroughSignTx, options);
      expect(res1.txHash).toBe(res2.txHash);
      // The hash is the one the network returned for the submitted transaction.
      expect(res1.txHash).toBe(CREATE_TX_HASH);
      assertNoRandomFallback(res1.txHash, 'createProposal regression');
    } finally {
      rpcStub.restore();
    }
  });

  it('vetoProposal does not return Math.random()-based hash when signer is present', async () => {
    const created = { proposalId: 2 };

    const hash1 = await vetoProposal(created.proposalId, '0xreason', SIGNER, signTx);
    clearGovernanceIdempotencyCache();
    const hash2 = await vetoProposal(created.proposalId, '0xreason', SIGNER, signTx);
    expect(hash1).toBe(hash2);
    assertNoRandomFallback(hash1, 'vetoProposal regression');
  });
});

describe('governance network mismatch protection (#1067)', () => {
  beforeEach(() => {
    signTx.mockClear();
    clearGovernanceIdempotencyCache();
    establishGovernanceTestSession(SIGNER);
  });

  it('castVote succeeds when wallet network matches configured network', async () => {
    const result = await castVote(1, 'For', SIGNER, signTx, { walletNetwork: 'testnet' });
    expect(signTx).toHaveBeenCalledWith(expect.stringContaining('vote:1:For'));
    assertNoRandomFallback(result, 'castVote matching network');
  });

  it('castVote blocks signing and mutation when wallet network differs from configured network', async () => {
    const proposalBefore = await fetchProposal(1);
    const votesBefore = proposalBefore?.votesFor ?? 0;

    await expect(
      castVote(1, 'For', SIGNER, signTx, { walletNetwork: 'mainnet' })
    ).rejects.toThrow(GovernanceNetworkMismatchError);

    await expect(
      castVote(1, 'For', SIGNER, signTx, { walletNetwork: 'PUBLIC' })
    ).rejects.toThrow(/NETWORK_MISMATCH/);

    expect(signTx).not.toHaveBeenCalled();
    const proposalAfter = await fetchProposal(1);
    expect(proposalAfter?.votesFor).toBe(votesBefore);
  });

  it('createProposal succeeds when wallet network matches configured network', async () => {
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Valid network proposal',
      description: 'Testing matching network configuration',
      newValueBps: 25,
    };
    establishGovernanceTestSession(PROPOSER);
    const rpcStub = stubProposalRpc({ proposalId: 88 });
    try {
      const res = await createProposal(payload, PROPOSER, passthroughSignTx, {
        context: PROPOSAL_CONTEXT,
        walletNetwork: 'testnet',
      });
      expect(res.proposalId).toBe(88);
      expect(res.txHash).toBe(CREATE_TX_HASH);
      assertNoRandomFallback(res.txHash, 'createProposal matching network');
      expect(rpcStub.sendTransaction).toHaveBeenCalledTimes(1);
    } finally {
      rpcStub.restore();
    }
  });

  it('createProposal blocks signing and submission when wallet network differs', async () => {
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Mismatched network proposal',
      description: 'Must fail before building or signing',
      newValueBps: 25,
    };
    establishGovernanceTestSession(PROPOSER);
    const rpcStub = stubProposalRpc();
    const proposalSign = vi.fn(passthroughSignTx);
    try {
      await expect(
        createProposal(payload, PROPOSER, proposalSign, {
          context: PROPOSAL_CONTEXT,
          walletNetwork: 'mainnet',
        })
      ).rejects.toThrow(GovernanceNetworkMismatchError);

      expect(proposalSign).not.toHaveBeenCalled();
      expect(rpcStub.sendTransaction).not.toHaveBeenCalled();
    } finally {
      rpcStub.restore();
    }
  });

  it('vetoProposal blocks signing and mutation when wallet network differs', async () => {
    const created = { proposalId: 3 };
    const proposalBefore = await fetchProposal(created.proposalId);
    const statusBefore = proposalBefore?.status;

    await expect(
      vetoProposal(created.proposalId, '0xmismatch_reason', SIGNER, signTx, {
        walletNetwork: 'mainnet',
      })
    ).rejects.toThrow(GovernanceNetworkMismatchError);

    expect(signTx).not.toHaveBeenCalled();
    const proposalAfter = await fetchProposal(created.proposalId);
    expect(proposalAfter?.status).toBe(statusBefore);
  });

  it('executeProposal blocks signing and mutation when wallet network differs', async () => {
    const proposalId = 4;
    const proposalBefore = await fetchProposal(proposalId);
    const statusBefore = proposalBefore?.status;

    await expect(
      executeProposal(proposalId, SIGNER, signTx, {
        walletNetwork: 'mainnet',
      })
    ).rejects.toThrow(GovernanceNetworkMismatchError);

    expect(signTx).not.toHaveBeenCalled();
    const proposalAfter = await fetchProposal(proposalId);
    expect(proposalAfter?.status).toBe(statusBefore);
  });

  it('regression guard: no mock/random fallback returns on network mismatch attempts', async () => {
    await expect(
      castVote(1, 'For', SIGNER, signTx, { walletNetwork: 'PUBLIC' })
    ).rejects.toThrow();
    expect(signTx).not.toHaveBeenCalled();
  });
});

describe('governance duplicate-submit lock (#1068)', () => {
  beforeEach(() => {
    signTx.mockClear();
    clearGovernanceIdempotencyCache();
    establishGovernanceTestSession(SIGNER);
  });

  it('castVote: rapid repeated clicks produce one transaction request and one result', async () => {
    const proposalBefore = await fetchProposal(6);
    const votesBefore = proposalBefore?.votesFor ?? 0;

    const [first, second, third] = await Promise.all([
      castVote(6, 'For', SIGNER, signTx),
      castVote(6, 'For', SIGNER, signTx),
      castVote(6, 'For', SIGNER, signTx),
    ]);

    expect(signTx).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(second).toBe(third);
    assertNoRandomFallback(first, 'castVote duplicate lock');

    const proposalAfter = await fetchProposal(6);
    expect(proposalAfter?.votesFor).toBe(votesBefore + 1250);
  });

  it('castVote: in-flight lock releases after error so user can retry successfully', async () => {
    const failingSignTx = vi.fn().mockRejectedValueOnce(new Error('User declined in wallet'));
    await expect(castVote(6, 'For', SIGNER, failingSignTx)).rejects.toThrow();

    // After failure, lock is released: a subsequent click succeeds and calls signTx
    const successResult = await castVote(6, 'For', SIGNER, signTx);
    expect(signTx).toHaveBeenCalledTimes(1);
    assertNoRandomFallback(successResult, 'castVote retry after failure');
  });

  it('createProposal: rapid repeated clicks produce one transaction request and one proposal', async () => {
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Rapid clicks proposal',
      description: 'Deduplication across concurrent submissions',
      newValueBps: 45,
    };
    establishGovernanceTestSession(PROPOSER);
    const rpcStub = stubProposalRpc({ proposalId: 99 });
    const proposalSign = vi.fn(passthroughSignTx);
    try {
      const [res1, res2, res3] = await Promise.all([
        createProposal(payload, PROPOSER, proposalSign, { context: PROPOSAL_CONTEXT }),
        createProposal(payload, PROPOSER, proposalSign, { context: PROPOSAL_CONTEXT }),
        createProposal(payload, PROPOSER, proposalSign, { context: PROPOSAL_CONTEXT }),
      ]);

      expect(proposalSign).toHaveBeenCalledTimes(1);
      expect(rpcStub.sendTransaction).toHaveBeenCalledTimes(1);
      expect(res1.txHash).toBe(res2.txHash);
      expect(res2.txHash).toBe(res3.txHash);
      expect(res1.proposalId).toBe(99);
      expect(res2.proposalId).toBe(99);
      assertNoRandomFallback(res1.txHash, 'createProposal duplicate lock');
    } finally {
      rpcStub.restore();
    }
  });

  it('vetoProposal: rapid repeated clicks produce one transaction request and one veto record', async () => {
    const created = { proposalId: 5 };
    const reason = '0xrapid_veto_reason';

    const [tx1, tx2, tx3] = await Promise.all([
      vetoProposal(created.proposalId, reason, SIGNER, signTx),
      vetoProposal(created.proposalId, reason, SIGNER, signTx),
      vetoProposal(created.proposalId, reason, SIGNER, signTx),
    ]);

    expect(signTx).toHaveBeenCalledTimes(1);
    expect(tx1).toBe(tx2);
    expect(tx2).toBe(tx3);
    assertNoRandomFallback(tx1, 'vetoProposal duplicate lock');

    const proposalAfter = await fetchProposal(created.proposalId);
    expect(proposalAfter?.status).toBe('Vetoed');
    const records = proposalAfter?.vetoHistory?.filter((r) => r.reasonHash === reason) ?? [];
    expect(records.length).toBe(1);
  });

  it('executeProposal: rapid repeated clicks produce one transaction request and one result', async () => {
    const proposalId = 6;

    const [tx1, tx2] = await Promise.all([
      executeProposal(proposalId, SIGNER, signTx),
      executeProposal(proposalId, SIGNER, signTx),
    ]);

    expect(signTx).toHaveBeenCalledTimes(1);
    expect(tx1).toBe(tx2);
    assertNoRandomFallback(tx1, 'executeProposal duplicate lock');

    const proposalAfter = await fetchProposal(proposalId);
    expect(proposalAfter?.status).toBe('Executed');
  });

  it('regression guard: duplicate submissions never generate random fallbacks or multiple hashes', async () => {
    const [h1, h2] = await Promise.all([
      castVote(5, 'Against', SIGNER, signTx),
      castVote(5, 'Against', SIGNER, signTx),
    ]);
    expect(h1).toBe(h2);
    assertNoRandomFallback(h1, 'regression duplicate clicks');
    expect(signTx).toHaveBeenCalledTimes(1);
  });
});

describe('governance contract read fallbacks (#1069)', () => {
  beforeEach(() => {
    signTx.mockClear();
    clearGovernanceIdempotencyCache();
    establishGovernanceTestSession(SIGNER);
  });

  it('fetchProposals succeeds when contract returns valid proposal list', async () => {
    const proposals = await fetchProposals();
    expect(Array.isArray(proposals)).toBe(true);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals[0]).toHaveProperty('id');
    expect(proposals[0]).toHaveProperty('title');
    expect(proposals[0]).toHaveProperty('status');
  });

  it('fetchProposals fails closed with GovernanceReadError when RPC returns simulation error', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValueOnce({
        error: 'Simulation failed: host error',
      } as any);

    await expect(fetchProposals()).rejects.toThrow(GovernanceReadError);
    await expect(fetchProposals()).rejects.toThrow(/GOVERNANCE_READ_UNAVAILABLE/);
    mockSimulate.mockRestore();
  });

  it('fetchProposals fails closed when network transport fails', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockRejectedValueOnce(new Error('500 Internal Server Error: RPC node unreachable'));

    await expect(fetchProposals()).rejects.toThrow(GovernanceReadError);
    await expect(fetchProposals()).rejects.toThrow(/GOVERNANCE_READ_UNAVAILABLE/);
    mockSimulate.mockRestore();
  });

  it('fetchProposal fails closed with GovernanceReadError when RPC fails', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockRejectedValueOnce(new Error('RPC connection refused'));

    await expect(fetchProposal(1)).rejects.toThrow(GovernanceReadError);
    mockSimulate.mockRestore();
  });

  it('regression guard: RPC failures produce unavailable error rather than fabricated mock values', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValueOnce({
        error: 'RPC simulation error',
      } as any);

    // Must NOT return MOCK_PROPOSALS
    await expect(fetchProposals()).rejects.toThrow(GovernanceReadError);
    mockSimulate.mockRestore();
  });

  it('blocks vote mutation when voting power read fails (#1069)', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockImplementation(async (tx: any) => {
        const op = tx?.operations?.[0];
        if (op?.function === 'get_voting_power') {
          return { error: 'Simulation failed' } as any;
        }
        return { error: 'offline' } as any;
      });

    await expect(castVote(1, 'For', SIGNER, signTx)).rejects.toThrow(
      /VOTING_POWER_UNAVAILABLE/
    );
    expect(signTx).not.toHaveBeenCalled();
    mockSimulate.mockRestore();
  });
});

describe('governance event decoding fixtures (#1066)', () => {
  it('decodes proposal_created deterministic fixture correctly', () => {
    const fixture = createProposalCreatedFixture(GOVERNANCE_CONTRACT_ID, 101, SIGNER, 'UpdateFeeRate');
    const decoded = decodeProposalCreatedEvent(fixture);

    expect(decoded).not.toBeNull();
    expect(decoded?.kind).toBe('proposal_created');
    expect(decoded?.proposalId).toBe(101);
    expect(decoded?.proposer).toBe(SIGNER);
    expect(decoded?.actionType).toBe('UpdateFeeRate');
    expect(decoded?.title).toBe('Test Proposal Title');
  });

  it('decodes proposal_executed deterministic fixture correctly', () => {
    const fixture = createProposalExecutedFixture(GOVERNANCE_CONTRACT_ID, 101, 'UpdateFeeRate', {
      proposedValue: 30,
      votesFor: 5000,
      votesAgainst: 200,
    });
    const decoded = decodeProposalExecutedEvent(fixture);

    expect(decoded).not.toBeNull();
    expect(decoded?.kind).toBe('proposal_executed');
    expect(decoded?.proposalId).toBe(101);
    expect(decoded?.proposedValue).toBe(30n);
    expect(decoded?.votesFor).toBe(5000n);
    expect(decoded?.votesAgainst).toBe(200n);
  });

  it('decodes vote_cast deterministic fixture correctly across all choices', () => {
    for (const choice of ['For', 'Against', 'Abstain'] as const) {
      const fixture = createVoteCastFixture(GOVERNANCE_CONTRACT_ID, 101, SIGNER, choice, 1250);
      const decoded = decodeVoteCastEvent(fixture);

      expect(decoded).not.toBeNull();
      expect(decoded?.kind).toBe('vote_cast');
      expect(decoded?.proposalId).toBe(101);
      expect(decoded?.choice).toBe(choice);
      expect(decoded?.votingPower).toBe(1250n);
      expect(decoded?.voter).toBe(SIGNER);
    }
  });

  it('decodes proposal_vetoed deterministic fixture correctly', () => {
    const fixture = createProposalVetoedFixture(
      GOVERNANCE_CONTRACT_ID,
      101,
      SIGNER,
      '0xdeadbeef00000000000000000000000000000000000000000000000000000000'
    );
    const decoded = decodeProposalVetoedEvent(fixture);

    expect(decoded).not.toBeNull();
    expect(decoded?.kind).toBe('proposal_vetoed');
    expect(decoded?.proposalId).toBe(101);
    expect(decoded?.admin).toBe(SIGNER);
    expect(decoded?.reasonHash).toBe('0xdeadbeef00000000000000000000000000000000000000000000000000000000');
  });

  it('decodes parameter_updated deterministic fixture correctly', () => {
    const fixture = createParameterUpdatedFixture(
      GOVERNANCE_CONTRACT_ID,
      'voting_period',
      86400,
      172800,
      SIGNER
    );
    const decoded = decodeParameterUpdatedEvent(fixture);

    expect(decoded).not.toBeNull();
    expect(decoded?.kind).toBe('parameter_updated');
    expect(decoded?.parameter).toBe('voting_period');
    expect(decoded?.oldValue).toBe(86400n);
    expect(decoded?.newValue).toBe(172800n);
    expect(decoded?.updatedBy).toBe(SIGNER);
  });

  it('decodeGovernanceEvent universal router decodes all event types and rejects unknown events', () => {
    const pCreated = createProposalCreatedFixture(GOVERNANCE_CONTRACT_ID, 1, SIGNER);
    const pExec = createProposalExecutedFixture(GOVERNANCE_CONTRACT_ID, 1);
    const vCast = createVoteCastFixture(GOVERNANCE_CONTRACT_ID, 1, SIGNER, 'For');
    const pVeto = createProposalVetoedFixture(GOVERNANCE_CONTRACT_ID, 1, SIGNER, '0xreason');
    const paramUp = createParameterUpdatedFixture(GOVERNANCE_CONTRACT_ID, 'p', 1, 2);

    expect(decodeGovernanceEvent(pCreated)?.kind).toBe('proposal_created');
    expect(decodeGovernanceEvent(pExec)?.kind).toBe('proposal_executed');
    expect(decodeGovernanceEvent(vCast)?.kind).toBe('vote_cast');
    expect(decodeGovernanceEvent(pVeto)?.kind).toBe('proposal_vetoed');
    expect(decodeGovernanceEvent(paramUp)?.kind).toBe('parameter_updated');
  });

  it('rejects malformed payloads without unhandled exceptions or fabricated fallback data', () => {
    const malformed = {
      topic: [nativeToScVal('proposal_created', { type: 'symbol' })],
      value: nativeToScVal(999),
    } as any;

    expect(decodeProposalCreatedEvent(malformed)).toBeNull();
    expect(() => decodeProposalCreatedEvent(malformed, { strict: true })).toThrow(EventDecodingError);
    expect(() => decodeProposalCreatedEvent(malformed, { strict: true })).toThrow(/MALFORMED_EVENT_PAYLOAD/);
  });
});

