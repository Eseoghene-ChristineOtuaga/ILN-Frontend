/**
 * @file governance.sync.test.ts
 *
 * Deterministic coverage for the governance write-path reconciliation,
 * simulation gating, signature cancellation, and query-cache invalidation
 * behaviour requested in issues #1062–#1065.
 *
 * Each section proves one contract:
 *
 *  - #1062 rejected signature: a declined wallet leaves proposal state and the
 *    query cache byte-for-byte unchanged (no tally, no status, no veto record,
 *    no appended proposal, no invalidation).
 *  - #1063 failed simulation: a failed / throwing dry-run throws a typed
 *    simulation error and never opens the wallet prompt (`signTx` uncalled).
 *  - #1064 confirmation reconciliation: fixed ledger fixtures resolve a
 *    transaction to exactly one of pending / confirmed / failed / timed-out.
 *  - #1065 query-cache invalidation: only a confirmed mutation invalidates
 *    the dependent proposal-list, proposal-detail and voting-power queries.
 *
 * No production path here fabricates a hash or a verdict, and the regression
 * assertions fail if a `Math.random()` / `unsigned:` fallback returns.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  castVote,
  clearGovernanceIdempotencyCache,
  createProposal,
  executeProposal,
  fetchProposal,
  fetchProposals,
  getVetoHistory,
  vetoProposal,
  type CreateProposalPayload,
} from '../governance';
import { isValidTxHash } from '../explorer';
import {
  reconcileGovernanceConfirmation,
  isGovernanceConfirmationSettled,
  type GovernanceLedgerReader,
  type GovernanceLedgerTransaction,
} from '@/lib/governance/confirmation';
import {
  GovernanceSimulationError,
  GOVERNANCE_SIMULATION_FAILED,
  assertGovernanceSimulationPassed,
  isGovernanceSimulationError,
  type GovernanceSimulationOutcome,
} from '@/lib/governance/simulation';
import {
  governanceInvalidationKeys,
  invalidateGovernanceMutationQueries,
} from '@/hooks/queries/governanceInvalidation';
import { governanceKeys } from '@/hooks/queries/keys';
import {
  clearGovernanceTestSession,
  establishGovernanceTestSession,
} from './helpers/governanceSession';
import {
  PROPOSAL_CONTEXT,
  PROPOSER,
  passthroughSignTx,
  stubProposalRpc,
} from './helpers/proposalRpc';

const SIGNER = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ';

const okSignTx = vi.fn(async (xdr: string) => `signed-${xdr}`);
const rejectSignTx = vi.fn(async (_xdr: string): Promise<string> => {
  throw new Error('User rejected the transaction');
});

const okSimulation = async (): Promise<GovernanceSimulationOutcome> => ({ success: true });
const failedSimulation = async (): Promise<GovernanceSimulationOutcome> => ({
  success: false,
  error: 'HostError: InvalidAction',
});

// Regression guard (#1070 lineage): a real signer must never yield an
// `unsigned:` marker or a `Math.random()`-style hash.
function assertNoRandomFallback(hash: string, context: string) {
  expect(hash, `${context}: must not start with 'unsigned:'`).not.toMatch(/^unsigned:/);
  expect(hash, `${context}: must not contain 'random'`).not.toMatch(/random/i);
  expect(isValidTxHash(hash), `${context}: must be a valid 64-char hex hash`).toBe(true);
}

function invalidatorSpy() {
  return { invalidateQueries: vi.fn(async (_filters: { queryKey: readonly unknown[] }) => {}) };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearGovernanceIdempotencyCache();
  establishGovernanceTestSession(SIGNER);
});

afterEach(() => {
  clearGovernanceTestSession();
});

// ─── #1062 rejected governance signature ─────────────────────────────────────

describe('governance rejected signature (#1062)', () => {
  it('castVote: cancelling the wallet leaves the tally, user vote and cache unchanged', async () => {
    const invalidator = invalidatorSpy();
    const before = await fetchProposal(2);
    const onConfirmed = vi.fn((hash: string) =>
      invalidateGovernanceMutationQueries(invalidator, {
        proposalId: 2,
        voterAddress: SIGNER,
      })
    );

    await expect(
      castVote(2, 'For', SIGNER, rejectSignTx, { simulate: okSimulation, onConfirmed })
    ).rejects.toThrow(/USER_REJECTED/i);

    const after = await fetchProposal(2);
    expect(after?.userVote).toBe(before?.userVote);
    expect(after?.votesFor).toBe(before?.votesFor);
    expect(after?.votesAgainst).toBe(before?.votesAgainst);
    // A declined signature is not a confirmed mutation: nothing is invalidated.
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(invalidator.invalidateQueries).not.toHaveBeenCalled();
  });

  it('createProposal: cancelling the wallet appends nothing and invalidates nothing', async () => {
    const invalidator = invalidatorSpy();
    const beforeCount = (await fetchProposals()).length;
    const onConfirmed = vi.fn((hash: string) =>
      invalidateGovernanceMutationQueries(invalidator, { voterAddress: SIGNER })
    );
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Rejected proposal must not exist',
      description: 'Wallet declines the create_proposal signature',
      newValueBps: 42,
    };
    establishGovernanceTestSession(PROPOSER);
    const rpcStub = stubProposalRpc();

    try {
      await expect(
        createProposal(payload, PROPOSER, rejectSignTx, {
          simulate: okSimulation,
          onConfirmed,
          context: PROPOSAL_CONTEXT,
        })
      ).rejects.toThrow(/USER_REJECTED/i);
      expect(rpcStub.sendTransaction).not.toHaveBeenCalled();
    } finally {
      rpcStub.restore();
    }

    expect((await fetchProposals()).length).toBe(beforeCount);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(invalidator.invalidateQueries).not.toHaveBeenCalled();
  });

  it('vetoProposal: cancelling the wallet records no veto and invalidates nothing', async () => {
    const invalidator = invalidatorSpy();
    const historyBefore = getVetoHistory(3);
    const before = await fetchProposal(3);
    const onConfirmed = vi.fn((hash: string) =>
      invalidateGovernanceMutationQueries(invalidator, { proposalId: 3 })
    );

    await expect(
      vetoProposal(3, '0xdeclined', SIGNER, rejectSignTx, { simulate: okSimulation, onConfirmed })
    ).rejects.toThrow(/USER_REJECTED/i);

    expect(getVetoHistory(3)).toEqual(historyBefore);
    expect((await fetchProposal(3))?.status).toBe(before?.status);
    expect(onConfirmed).not.toHaveBeenCalled();
    expect(invalidator.invalidateQueries).not.toHaveBeenCalled();
  });

  it('executeProposal: cancelling the wallet leaves the status unchanged', async () => {
    const invalidator = invalidatorSpy();
    const before = await fetchProposal(6);
    const onConfirmed = vi.fn((hash: string) =>
      invalidateGovernanceMutationQueries(invalidator, { proposalId: 6 })
    );

    await expect(
      executeProposal(6, SIGNER, rejectSignTx, { simulate: okSimulation, onConfirmed })
    ).rejects.toThrow(/USER_REJECTED/i);

    expect((await fetchProposal(6))?.status).toBe(before?.status);
    expect(onConfirmed).not.toHaveBeenCalled();
  });
});

// ─── #1063 failed governance simulation ──────────────────────────────────────

describe('governance failed simulation (#1063)', () => {
  it('assertGovernanceSimulationPassed wraps a thrown dry-run in a typed error', async () => {
    const cause = new Error('RPC unreachable');
    await expect(
      assertGovernanceSimulationPassed(async () => {
        throw cause;
      })
    ).rejects.toBeInstanceOf(GovernanceSimulationError);

    await expect(
      assertGovernanceSimulationPassed(async () => {
        throw cause;
      })
    ).rejects.toMatchObject({
      code: GOVERNANCE_SIMULATION_FAILED,
      name: 'GovernanceSimulationError',
    });
  });

  it('assertGovernanceSimulationPassed throws on a non-success outcome and includes the diagnostic', async () => {
    await expect(assertGovernanceSimulationPassed(failedSimulation)).rejects.toThrow(
      /HostError: InvalidAction/
    );
    await expect(assertGovernanceSimulationPassed(failedSimulation)).rejects.toBeInstanceOf(
      GovernanceSimulationError
    );

    const surfaced = await assertGovernanceSimulationPassed(failedSimulation).catch(
      (error: unknown) => error
    );
    expect(isGovernanceSimulationError(surfaced)).toBe(true);
  });

  it('castVote: a failed simulation throws without opening the wallet prompt or mutating', async () => {
    const before = await fetchProposal(1);
    const onConfirmed = vi.fn();

    await expect(
      castVote(1, 'For', SIGNER, okSignTx, { simulate: failedSimulation, onConfirmed })
    ).rejects.toMatchObject({ code: GOVERNANCE_SIMULATION_FAILED });

    expect(okSignTx).not.toHaveBeenCalled();
    expect(onConfirmed).not.toHaveBeenCalled();
    const after = await fetchProposal(1);
    expect(after?.votesFor).toBe(before?.votesFor);
    expect(after?.userVote).toBe(before?.userVote);
  });

  it('createProposal: a failed simulation does not append a proposal', async () => {
    const beforeCount = (await fetchProposals()).length;
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Simulation failure must not append',
      description: 'Dry-run fails',
      newValueBps: 33,
    };

    await expect(
      createProposal(payload, SIGNER, okSignTx, { simulate: failedSimulation })
    ).rejects.toBeInstanceOf(GovernanceSimulationError);

    expect(okSignTx).not.toHaveBeenCalled();
    expect((await fetchProposals()).length).toBe(beforeCount);
  });

  it('createProposal: a throwing simulation is surfaced as a typed simulation error', async () => {
    const payload: CreateProposalPayload = {
      formType: 'MaxDiscountRate',
      title: 'Throwing simulation',
      description: 'Dry-run throws',
      newValueBps: 120,
    };

    await expect(
      createProposal(payload, SIGNER, okSignTx, {
        simulate: async () => {
          throw new Error('network down');
        },
      })
    ).rejects.toBeInstanceOf(GovernanceSimulationError);

    expect(okSignTx).not.toHaveBeenCalled();
  });

  it('a passing simulation allows signing and yields a deterministic, non-fallback hash', async () => {
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Passing simulation',
      description: 'Dry-run succeeds, so the wallet is asked to sign',
      newValueBps: 21,
    };
    establishGovernanceTestSession(PROPOSER);
    const rpcStub = stubProposalRpc();
    const signTx = vi.fn(passthroughSignTx);
    const options = { simulate: okSimulation, context: PROPOSAL_CONTEXT };

    try {
      const first = await createProposal(payload, PROPOSER, signTx, options);
      expect(signTx).toHaveBeenCalledTimes(1);
      assertNoRandomFallback(first.txHash, 'createProposal after successful simulation');

      // Replaying the identical payload is deduplicated and returns the same
      // confirmation without re-signing — same inputs, same hash.
      const second = await createProposal(payload, PROPOSER, signTx, options);
      expect(second.txHash).toBe(first.txHash);
      expect(second.proposalId).toBe(first.proposalId);
      expect(signTx).toHaveBeenCalledTimes(1);
      expect(rpcStub.sendTransaction).toHaveBeenCalledTimes(1);
    } finally {
      rpcStub.restore();
    }
  });

  it('castVote: a passing simulation applies the vote exactly once', async () => {
    const before = await fetchProposal(5);
    const hash = await castVote(5, 'Against', SIGNER, okSignTx, { simulate: okSimulation });
    assertNoRandomFallback(hash, 'castVote after successful simulation');

    const after = await fetchProposal(5);
    expect(after?.userVote).toBe('Against');
    expect(after?.votesAgainst).toBe((before?.votesAgainst ?? 0) + 1250);
  });
});

// ─── #1064 governance confirmation reconciliation ────────────────────────────

describe('governance confirmation reconciliation (#1064)', () => {
  const HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  function ledgerFixture(options: {
    transactions?: Record<string, GovernanceLedgerTransaction>;
    latestLedger: number;
    failRead?: boolean;
  }): GovernanceLedgerReader {
    return {
      getTransaction: async (hash) => {
        if (options.failRead) throw new Error('RPC unavailable');
        return options.transactions?.[hash] ?? null;
      },
      getLatestLedger: async () => {
        if (options.failRead) throw new Error('RPC unavailable');
        return options.latestLedger;
      },
    };
  }

  it('reports confirmed when the ledger contains a successful transaction', async () => {
    const reader = ledgerFixture({
      transactions: { [HASH]: { hash: HASH, ledger: 1002, successful: true } },
      latestLedger: 1010,
    });

    const receipt = await reconcileGovernanceConfirmation({
      hash: HASH,
      submittedAtLedger: 1000,
      maxLedgerWait: 20,
      reader,
    });

    expect(receipt).toEqual({ hash: HASH, state: 'confirmed', ledger: 1002 });
    expect(isGovernanceConfirmationSettled(receipt.state)).toBe(true);
  });

  it('reports failed when the ledger contains a failed transaction', async () => {
    const reader = ledgerFixture({
      transactions: { [HASH]: { hash: HASH, ledger: 1005, successful: false } },
      latestLedger: 1010,
    });

    const receipt = await reconcileGovernanceConfirmation({
      hash: HASH,
      submittedAtLedger: 1000,
      maxLedgerWait: 20,
      reader,
    });

    expect(receipt).toEqual({ hash: HASH, state: 'failed', ledger: 1005 });
    expect(isGovernanceConfirmationSettled(receipt.state)).toBe(true);
  });

  it('reports pending while the transaction has not appeared and the window is open', async () => {
    const reader = ledgerFixture({ latestLedger: 1009 });

    const receipt = await reconcileGovernanceConfirmation({
      hash: HASH,
      submittedAtLedger: 1000,
      maxLedgerWait: 20,
      reader,
    });

    expect(receipt).toEqual({
      hash: HASH,
      state: 'pending',
      reason: 'awaiting-ledger-window',
    });
    expect(isGovernanceConfirmationSettled(receipt.state)).toBe(false);
  });

  it('reports timed-out once the ledger window elapses without the transaction', async () => {
    const reader = ledgerFixture({ latestLedger: 1020 });

    const receipt = await reconcileGovernanceConfirmation({
      hash: HASH,
      submittedAtLedger: 1000,
      maxLedgerWait: 20,
      reader,
    });

    expect(receipt).toEqual({ hash: HASH, state: 'timed-out', reason: 'not-found' });
  });

  it('never assumes a verdict from an unreachable ledger: stays pending', async () => {
    const reader = ledgerFixture({ latestLedger: 9999, failRead: true });

    const receipt = await reconcileGovernanceConfirmation({
      hash: HASH,
      submittedAtLedger: 1000,
      maxLedgerWait: 20,
      reader,
    });

    expect(receipt).toEqual({ hash: HASH, state: 'pending', reason: 'ledger-unreachable' });
  });

  it('rejects a mismatched ledger record instead of silently accepting it', async () => {
    const reader = ledgerFixture({
      transactions: { [HASH]: { hash: 'deadbeef', ledger: 1001, successful: true } },
      latestLedger: 1010,
    });

    await expect(
      reconcileGovernanceConfirmation({
        hash: HASH,
        submittedAtLedger: 1000,
        maxLedgerWait: 20,
        reader,
      })
    ).rejects.toThrow(/returned transaction/);
  });

  it('rejects invalid ledger windows rather than fabricating a state', async () => {
    const reader = ledgerFixture({ latestLedger: 1010 });
    await expect(
      reconcileGovernanceConfirmation({
        hash: HASH,
        submittedAtLedger: 1000,
        maxLedgerWait: 0,
        reader,
      })
    ).rejects.toThrow(/maxLedgerWait/);
  });

  it('is deterministic: identical fixtures always yield the same state', async () => {
    const build = () =>
      ledgerFixture({
        transactions: { [HASH]: { hash: HASH, ledger: 1003, successful: true } },
        latestLedger: 1010,
      });

    const [first, second] = await Promise.all([
      reconcileGovernanceConfirmation({
        hash: HASH,
        submittedAtLedger: 1000,
        maxLedgerWait: 20,
        reader: build(),
      }),
      reconcileGovernanceConfirmation({
        hash: HASH,
        submittedAtLedger: 1000,
        maxLedgerWait: 20,
        reader: build(),
      }),
    ]);

    expect(first).toEqual(second);
  });
});

// ─── #1065 / #1047 governance query cache invalidation ───────────────────────

describe('governance query cache invalidation (#1065, #1047)', () => {
  it('derives the proposals list plus the scoped detail, power, and activity keys', () => {
    const keys = governanceInvalidationKeys({ proposalId: 7, voterAddress: SIGNER });

    expect(keys).toEqual([
      governanceKeys.proposals,
      governanceKeys.proposal(7),
      governanceKeys.votingPower(SIGNER),
      governanceKeys.activity(SIGNER),
    ]);
  });

  it('always invalidates the proposals list and activity, even with an empty scope', () => {
    expect(governanceInvalidationKeys()).toEqual([
      governanceKeys.proposals,
      governanceKeys.activity(),
    ]);
  });

  it('invalidateGovernanceMutationQueries refreshes every dependent query', async () => {
    const invalidator = invalidatorSpy();

    await invalidateGovernanceMutationQueries(invalidator, {
      proposalId: 3,
      voterAddress: SIGNER,
    });

    const invalidatedKeys = invalidator.invalidateQueries.mock.calls.map(
      ([filters]) => filters.queryKey
    );
    expect(invalidatedKeys).toEqual([
      governanceKeys.proposals,
      governanceKeys.proposal(3),
      governanceKeys.votingPower(SIGNER),
      governanceKeys.activity(SIGNER),
    ]);
  });

  it('a confirmed mutation refreshes proposal, activity, and voting-power data', async () => {
    const invalidator = invalidatorSpy();
    const onConfirmed = vi.fn((hash: string) =>
      invalidateGovernanceMutationQueries(invalidator, {
        proposalId: 3,
        voterAddress: SIGNER,
      })
    );

    const hash = await castVote(3, 'For', SIGNER, okSignTx, {
      simulate: okSimulation,
      onConfirmed,
    });
    assertNoRandomFallback(hash, 'confirmed castVote');

    expect(onConfirmed).toHaveBeenCalledTimes(1);
    expect(onConfirmed).toHaveBeenCalledWith(hash);
    expect(invalidator.invalidateQueries).toHaveBeenCalledTimes(4);
    const invalidatedKeys = invalidator.invalidateQueries.mock.calls.map(
      ([filters]) => filters.queryKey
    );
    expect(invalidatedKeys).toContainEqual(governanceKeys.proposals);
    expect(invalidatedKeys).toContainEqual(governanceKeys.proposal(3));
    expect(invalidatedKeys).toContainEqual(governanceKeys.votingPower(SIGNER));
    expect(invalidatedKeys).toContainEqual(governanceKeys.activity(SIGNER));
  });

  it('regression: a failed simulation invalidates no query cache (#1063/#1065)', async () => {
    const invalidator = invalidatorSpy();

    await expect(
      castVote(1, 'Against', SIGNER, okSignTx, {
        simulate: failedSimulation,
        onConfirmed: () =>
          invalidateGovernanceMutationQueries(invalidator, { proposalId: 1, voterAddress: SIGNER }),
      })
    ).rejects.toBeInstanceOf(GovernanceSimulationError);

    expect(invalidator.invalidateQueries).not.toHaveBeenCalled();
  });

  it('regression: a rejected signature invalidates no query cache (#1062/#1065)', async () => {
    const invalidator = invalidatorSpy();

    await expect(
      castVote(1, 'Against', SIGNER, rejectSignTx, {
        simulate: okSimulation,
        onConfirmed: () =>
          invalidateGovernanceMutationQueries(invalidator, { proposalId: 1, voterAddress: SIGNER }),
      })
    ).rejects.toThrow(/USER_REJECTED/i);

    expect(invalidator.invalidateQueries).not.toHaveBeenCalled();
  });
});
