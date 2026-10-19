/**
 * @file governance-tx.test.ts
 *
 * Covers the signed Soroban governance pipeline (#1044, #1045).
 *
 * Two behaviours are what these tests exist to pin down:
 *
 * 1. **Simulation runs before signing (#1044).** Every failed simulation must
 *    reject *without* `signTx` ever being called, and must carry an
 *    actionable code rather than a raw `HostError` string.
 *
 * 2. **Confirmation is bounded and its outcomes stay distinct (#1045).** A
 *    timeout, an on-chain failure, and a declined signature are three
 *    different errors with three different effects on the pending-transaction
 *    store — a timeout must never be reported as a failure.
 *
 * The RPC server is injected (`rpcServer`) rather than spied on globally, so
 * each test states exactly which network responses it is exercising.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  rpc,
  xdr,
  nativeToScVal,
  Account,
  Address,
  SorobanDataBuilder,
  TransactionBuilder,
  Operation,
  BASE_FEE,
} from '@stellar/stellar-sdk';

import {
  classifyGovernanceSimulationError,
  executeGovernanceMutation,
  fetchGovernanceTxOutcome,
  GovernanceSigningRejectedError,
  GovernanceSimulationError,
  GovernanceTxError,
  GovernanceTxFailedError,
  GovernanceTxTimeoutError,
  GOVERNANCE_MUTATION_ARITY,
  isGovernanceTimeoutError,
  isGovernanceUnavailableError,
  simulateGovernanceMutation,
  submitGovernanceMutation,
  type GovernanceMutationMethod,
} from '../governance-tx';
import { PENDING_TRANSACTIONS_STORAGE_KEY, getPendingTransactions } from '../pending-transactions';
import { NETWORK_PASSPHRASE } from '@/constants';

const SIGNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const TX_HASH = 'a'.repeat(64);

// A governance contract id must be configured for the write path to run; the
// module reads it at import time, so it is stubbed before the import above
// takes effect via vitest's module mocking.
vi.mock('@/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/constants')>();
  return {
    ...actual,
    GOVERNANCE_CONTRACT_CONFIGURED: true,
    GOVERNANCE_CONTRACT_ID: 'CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC',
  };
});

/**
 * A successful simulation in the exact shape `rpc.Server.simulateTransaction`
 * returns: already parsed (`_parsed: true`), with `transactionData` as a
 * `SorobanDataBuilder`. Matching the real shape means the production code runs
 * the real `rpc.assembleTransaction` rather than a stub of it, so a footprint
 * or fee regression in assembly would still be caught here.
 */
function simulationSuccess(retval?: xdr.ScVal) {
  return {
    _parsed: true,
    id: '1',
    latestLedger: 100,
    events: [],
    transactionData: new SorobanDataBuilder(),
    minResourceFee: '1000',
    result: {
      auth: [],
      retval: retval ?? nativeToScVal(7, { type: 'u64' }),
    },
  };
}

/**
 * Stub RPC server. Defaults to the happy path; each test overrides only the
 * call it is about.
 */
function makeRpcStub(
  overrides: Partial<{
    getAccount: ReturnType<typeof vi.fn>;
    simulateTransaction: ReturnType<typeof vi.fn>;
    sendTransaction: ReturnType<typeof vi.fn>;
    getTransaction: ReturnType<typeof vi.fn>;
  }> = {}
) {
  return {
    getAccount: vi.fn(async () => new Account(SIGNER, '42')),
    simulateTransaction: vi.fn(async () => simulationSuccess()),
    sendTransaction: vi.fn(async () => ({ hash: TX_HASH, status: 'PENDING' })),
    getTransaction: vi.fn(async () => ({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 1234,
      returnValue: nativeToScVal(7, { type: 'u64' }),
    })),
    ...overrides,
    // Justification: `rpc.Server` has ~30 methods, and the pipeline only ever
    // uses these four (its `rpcServer` parameter is typed as exactly that
    // Pick). Structurally typing the stub to the full class would require
    // stubbing every unrelated method; the cast is confined to this factory.
  } as any;
}

/**
 * A real prepared transaction and its XDR.
 *
 * `submitGovernanceMutation` round-trips the wallet's response through
 * `TransactionBuilder.fromXDR`, so the signed value has to be genuine XDR —
 * a placeholder string would only ever exercise the decode-failure branch.
 */
function buildRealTransaction() {
  return new TransactionBuilder(new Account(SIGNER, '42'), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: 'CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC',
        function: 'cast_vote',
        args: castVoteArgs(),
      })
    )
    .setTimeout(60)
    .build();
}

const castVoteArgs = () => [
  Address.fromString(SIGNER).toScVal(),
  nativeToScVal(1, { type: 'u64' }),
  nativeToScVal(1, { type: 'u32' }),
];

let prepared: ReturnType<typeof buildRealTransaction>;
let signedXdr: string;

beforeEach(() => {
  window.localStorage.removeItem(PENDING_TRANSACTIONS_STORAGE_KEY);
  prepared = buildRealTransaction();
  signedXdr = prepared.toXDR();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─── #1044: simulation before signing ────────────────────────────────────────

describe('simulateGovernanceMutation (#1044)', () => {
  it('simulates without requesting a signature', async () => {
    const client = makeRpcStub();
    const signTx = vi.fn();

    await simulateGovernanceMutation({
      method: 'cast_vote',
      args: castVoteArgs(),
      signerAddress: SIGNER,
      rpcServer: client,
    });

    expect(client.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(signTx).not.toHaveBeenCalled();
  });

  it('rejects an argument count that disagrees with the contract signature', async () => {
    const client = makeRpcStub();

    await expect(
      simulateGovernanceMutation({
        method: 'cast_vote',
        args: [Address.fromString(SIGNER).toScVal()],
        signerAddress: SIGNER,
        rpcServer: client,
      })
    ).rejects.toThrow(/expects 3 arguments but received 1/);

    // Failing arity must stop before the network is touched at all.
    expect(client.getAccount).not.toHaveBeenCalled();
    expect(client.simulateTransaction).not.toHaveBeenCalled();
  });

  it('reports an unloadable source account as SOURCE_ACCOUNT_MISSING', async () => {
    const client = makeRpcStub({
      getAccount: vi.fn(async () => {
        throw new Error('Account not found');
      }),
    });

    const error = await simulateGovernanceMutation({
      method: 'cast_vote',
      args: castVoteArgs(),
      signerAddress: SIGNER,
      rpcServer: client,
    }).catch((err) => err);

    expect(error).toBeInstanceOf(GovernanceTxError);
    expect(error.code).toBe('SOURCE_ACCOUNT_MISSING');
    expect(isGovernanceUnavailableError(error)).toBe(true);
  });

  it('classifies an archived-state simulation as recoverable, not as a failure', async () => {
    const client = makeRpcStub({
      simulateTransaction: vi.fn(async () => ({
        ...simulationSuccess(),
        restorePreamble: { minResourceFee: '500', transactionData: new SorobanDataBuilder() },
      })),
    });

    const error = await simulateGovernanceMutation({
      method: 'cast_vote',
      args: castVoteArgs(),
      signerAddress: SIGNER,
      rpcServer: client,
    }).catch((err) => err);

    expect(error).toBeInstanceOf(GovernanceSimulationError);
    expect(error.code).toBe('SIMULATION_ARCHIVED_STATE');
    expect(error.remediation).toMatch(/restore/i);
  });

  it('keeps an unreachable RPC endpoint distinct from a contract rejection', async () => {
    const client = makeRpcStub({
      simulateTransaction: vi.fn(async () => {
        throw new Error('fetch failed');
      }),
    });

    const error = await simulateGovernanceMutation({
      method: 'cast_vote',
      args: castVoteArgs(),
      signerAddress: SIGNER,
      rpcServer: client,
    }).catch((err) => err);

    expect(error.code).toBe('SIMULATION_FAILED');
    expect(error.remediation).toMatch(/unreachable/i);
    expect(error.diagnostics).toContain('fetch failed');
  });

  it('never prompts the wallet when simulation fails', async () => {
    const signTx = vi.fn(async () => 'signed');
    const client = makeRpcStub({
      simulateTransaction: vi.fn(async () => ({
        _parsed: true,
        error: 'HostError: Error(Auth, InvalidAction)',
        id: '1',
        latestLedger: 1,
        events: [],
      })),
    });

    await expect(
      executeGovernanceMutation({
        method: 'cast_vote',
        args: castVoteArgs(),
        signerAddress: SIGNER,
        signTx,
        rpcServer: client,
      })
    ).rejects.toBeInstanceOf(GovernanceSimulationError);

    // The whole point of #1044: no signature was requested, and nothing was
    // submitted, for a transaction that could not have succeeded.
    expect(signTx).not.toHaveBeenCalled();
    expect(client.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('classifyGovernanceSimulationError (#1044)', () => {
  const cases: Array<{
    name: string;
    raw: string;
    code: string;
    remediation: RegExp;
  }> = [
    {
      name: 'a missing entry point (contract has no governance support)',
      raw: 'HostError: Error(WasmVm, MissingValue) trying to get non-existent function',
      code: 'ENTRYPOINT_MISSING',
      remediation: /NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID/,
    },
    {
      name: 'a missing storage key (unknown proposal)',
      raw: 'HostError: Error(Storage, MissingValue)',
      code: 'PROPOSAL_NOT_FOUND',
      remediation: /reload/i,
    },
    {
      name: 'an authorization rejection',
      raw: 'HostError: Error(Auth, InvalidAction)',
      code: 'SIMULATION_UNAUTHORIZED',
      remediation: /not authorized/i,
    },
    {
      name: 'a require_auth failure',
      raw: 'transaction simulation failed: require_auth for address failed',
      code: 'SIMULATION_UNAUTHORIZED',
      remediation: /not authorized/i,
    },
    {
      name: 'an exceeded resource budget',
      raw: 'HostError: Error(Budget, ExceededLimit)',
      code: 'SIMULATION_INSUFFICIENT_RESOURCES',
      remediation: /resource|retry/i,
    },
    {
      name: 'an insufficient refundable fee',
      raw: 'insufficient refundable fee for this transaction',
      code: 'SIMULATION_INSUFFICIENT_RESOURCES',
      remediation: /resource|retry/i,
    },
    {
      name: 'a contract-defined error code',
      raw: 'HostError: Error(Contract, #7)',
      code: 'SIMULATION_CONTRACT_ERROR',
      remediation: /voting twice|voting window/i,
    },
    {
      name: 'an unrecognised failure',
      raw: 'something entirely unexpected went wrong',
      code: 'SIMULATION_FAILED',
      remediation: /no signature was requested/i,
    },
  ];

  for (const testCase of cases) {
    it(`maps ${testCase.name} to ${testCase.code} with actionable remediation`, () => {
      const error = classifyGovernanceSimulationError(testCase.raw, 'cast_vote');

      expect(error.code).toBe(testCase.code);
      expect(error.remediation).toMatch(testCase.remediation);
      // The raw diagnostic is preserved for the technical-details panel but is
      // never what the user is shown first.
      expect(error.diagnostics).toBe(testCase.raw);
      expect(error.message).not.toBe(testCase.raw);
    });
  }

  it('distinguishes a missing entry point from a missing storage key', () => {
    // Both surface as `MissingValue`; only the subsystem tells them apart, and
    // conflating them would tell a user to reconfigure the contract when the
    // real problem is a stale proposal id.
    const wasmVm = classifyGovernanceSimulationError('Error(WasmVm, MissingValue)');
    const storage = classifyGovernanceSimulationError('Error(Storage, MissingValue)');

    expect(wasmVm.code).toBe('ENTRYPOINT_MISSING');
    expect(storage.code).toBe('PROPOSAL_NOT_FOUND');
  });

  it('treats a simulation error as safe to retry once its cause is fixed', () => {
    // Nothing was signed or submitted, so a corrected retry cannot
    // double-apply the action.
    expect(classifyGovernanceSimulationError('Error(Auth, InvalidAction)').resubmitSafe).toBe(true);
  });
});

// ─── #1045: bounded confirmation ─────────────────────────────────────────────

describe('submitGovernanceMutation confirmation bounds (#1045)', () => {
  it('resolves with the settlement hash once RPC reports SUCCESS', async () => {
    const client = makeRpcStub();
    const stages: string[] = [];

    const confirmation = await submitGovernanceMutation({
      prepared: prepared,
      signTx: vi.fn(async () => signedXdr),
      method: 'cast_vote',
      onStage: (stage) => stages.push(stage),
      rpcServer: client,
      sleep: async () => {},
    });

    expect(confirmation.txHash).toBe(TX_HASH);
    expect(confirmation.ledger).toBe(1234);
    expect(stages).toEqual(['signed', 'submitted', 'confirming']);
    // A settled transaction leaves nothing pending.
    expect(getPendingTransactions()).toHaveLength(0);
  });

  it('throws a timeout — not a failure — when the attempt bound is reached', async () => {
    const client = makeRpcStub({
      getTransaction: vi.fn(async () => ({ status: rpc.Api.GetTransactionStatus.NOT_FOUND })),
    });

    const error = await submitGovernanceMutation({
      prepared: prepared,
      signTx: vi.fn(async () => signedXdr),
      method: 'cast_vote',
      attempts: 3,
      intervalMs: 1,
      timeoutMs: 60_000,
      rpcServer: client,
      sleep: async () => {},
    }).catch((err) => err);

    expect(error).toBeInstanceOf(GovernanceTxTimeoutError);
    expect(error).not.toBeInstanceOf(GovernanceTxFailedError);
    expect(isGovernanceTimeoutError(error)).toBe(true);
    expect(error.code).toBe('TX_TIMEOUT');
    expect(error.attempts).toBe(3);
    expect(client.getTransaction).toHaveBeenCalledTimes(3);
    // The hash is carried so the outcome can still be reconciled.
    expect(error.txHash).toBe(TX_HASH);
  });

  it('stops at the wall-clock deadline even when attempts remain', async () => {
    const client = makeRpcStub({
      getTransaction: vi.fn(async () => ({ status: rpc.Api.GetTransactionStatus.NOT_FOUND })),
    });
    // A slow RPC can make the attempt bound meaningless; the deadline is what
    // actually caps how long a user is left waiting.
    let now = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      now += 400;
      return now;
    });

    const error = await submitGovernanceMutation({
      prepared: prepared,
      signTx: vi.fn(async () => signedXdr),
      attempts: 100,
      intervalMs: 100,
      timeoutMs: 1_000,
      rpcServer: client,
      sleep: async () => {},
    }).catch((err) => err);

    expect(error).toBeInstanceOf(GovernanceTxTimeoutError);
    expect(error.attempts).toBeLessThan(100);
  });

  it('keeps the pending entry on timeout so the outcome can be reconciled', async () => {
    const client = makeRpcStub({
      getTransaction: vi.fn(async () => ({ status: rpc.Api.GetTransactionStatus.NOT_FOUND })),
    });

    await submitGovernanceMutation({
      prepared: prepared,
      signTx: vi.fn(async () => signedXdr),
      method: 'cast_vote',
      attempts: 2,
      intervalMs: 1,
      rpcServer: client,
      sleep: async () => {},
    }).catch(() => undefined);

    // Unknown outcome: the transaction may still confirm, so the entry stays.
    const pending = getPendingTransactions();
    expect(pending).toHaveLength(1);
    expect(pending[0].hash).toBe(TX_HASH);
  });

  it('never offers a resubmit after a timeout', async () => {
    const client = makeRpcStub({
      getTransaction: vi.fn(async () => ({ status: rpc.Api.GetTransactionStatus.NOT_FOUND })),
    });

    const error = await submitGovernanceMutation({
      prepared: prepared,
      signTx: vi.fn(async () => signedXdr),
      attempts: 1,
      intervalMs: 1,
      rpcServer: client,
      sleep: async () => {},
    }).catch((err) => err);

    // Re-signing a vote whose outcome is unknown risks voting twice.
    expect(error.resubmitSafe).toBe(false);
    expect(error.remediation).toMatch(/check its status/i);
  });

  it('settles and clears the pending entry on an on-chain FAILED verdict', async () => {
    const client = makeRpcStub({
      getTransaction: vi.fn(async () => ({
        status: rpc.Api.GetTransactionStatus.FAILED,
      })),
    });

    const error = await submitGovernanceMutation({
      prepared: prepared,
      signTx: vi.fn(async () => signedXdr),
      method: 'cast_vote',
      rpcServer: client,
      sleep: async () => {},
    }).catch((err) => err);

    expect(error).toBeInstanceOf(GovernanceTxFailedError);
    expect(error).not.toBeInstanceOf(GovernanceTxTimeoutError);
    expect(error.code).toBe('TX_FAILED');
    // A final verdict settles the entry rather than leaving it to reconcile.
    expect(getPendingTransactions()).toHaveLength(0);
    // Nothing was applied, so a corrected retry is safe.
    expect(error.resubmitSafe).toBe(true);
  });

  it('stops polling as soon as the network settles', async () => {
    const getTransaction = vi
      .fn()
      .mockResolvedValueOnce({ status: rpc.Api.GetTransactionStatus.NOT_FOUND })
      .mockResolvedValueOnce({ status: rpc.Api.GetTransactionStatus.SUCCESS, ledger: 9 });
    const client = makeRpcStub({ getTransaction });

    const confirmation = await submitGovernanceMutation({
      prepared: prepared,
      signTx: vi.fn(async () => signedXdr),
      attempts: 20,
      intervalMs: 1,
      rpcServer: client,
      sleep: async () => {},
    });

    expect(confirmation.ledger).toBe(9);
    expect(getTransaction).toHaveBeenCalledTimes(2);
  });

  it('reports a declined signature without submitting anything', async () => {
    const client = makeRpcStub();
    const signTx = vi.fn(async () => {
      throw new Error('User rejected the request');
    });

    const error = await submitGovernanceMutation({
      prepared: prepared,
      signTx,
      method: 'cast_vote',
      rpcServer: client,
      sleep: async () => {},
    }).catch((err) => err);

    expect(error).toBeInstanceOf(GovernanceSigningRejectedError);
    expect(error.code).toBe('USER_REJECTED');
    expect(client.sendTransaction).not.toHaveBeenCalled();
    // Nothing reached the network, so no pending entry was ever created.
    expect(getPendingTransactions()).toHaveLength(0);
    expect(error.resubmitSafe).toBe(true);
  });

  it('rethrows a non-cancellation signing error unchanged', async () => {
    const client = makeRpcStub();
    const signTx = vi.fn(async () => {
      throw new Error('wallet extension crashed');
    });

    await expect(
      submitGovernanceMutation({
        prepared: prepared,
        signTx,
        rpcServer: client,
        sleep: async () => {},
      })
    ).rejects.toThrow('wallet extension crashed');
  });

  it('reports a submission the network refused outright', async () => {
    const client = makeRpcStub({
      sendTransaction: vi.fn(async () => ({ hash: TX_HASH, status: 'ERROR' })),
    });

    const error = await submitGovernanceMutation({
      prepared: prepared,
      signTx: vi.fn(async () => signedXdr),
      rpcServer: client,
      sleep: async () => {},
    }).catch((err) => err);

    expect(error.code).toBe('SUBMISSION_REJECTED');
    expect(error.phase).toBe('submission');
    expect(client.getTransaction).not.toHaveBeenCalled();
  });

  it('accepts DUPLICATE as a submitted transaction rather than an error', async () => {
    // A duplicate means the network already has this exact transaction;
    // treating it as an error would strand a vote that is really in flight.
    const client = makeRpcStub({
      sendTransaction: vi.fn(async () => ({ hash: TX_HASH, status: 'DUPLICATE' })),
    });

    const confirmation = await submitGovernanceMutation({
      prepared: prepared,
      signTx: vi.fn(async () => signedXdr),
      rpcServer: client,
      sleep: async () => {},
    });

    expect(confirmation.txHash).toBe(TX_HASH);
  });
});

// ─── Post-timeout reconciliation (#1045) ─────────────────────────────────────

describe('fetchGovernanceTxOutcome (#1045)', () => {
  it.each([
    [rpc.Api.GetTransactionStatus.SUCCESS, 'confirmed'],
    [rpc.Api.GetTransactionStatus.FAILED, 'failed'],
    [rpc.Api.GetTransactionStatus.NOT_FOUND, 'pending'],
  ])('maps RPC status %s to %s', async (status, expected) => {
    const outcome = await fetchGovernanceTxOutcome(TX_HASH, {
      getTransaction: vi.fn(async () => ({ status })),
      // Justification: a one-method stub for a `Pick<rpc.Server, …>` parameter;
      // the SDK's GetTransactionResponse union cannot be satisfied by a literal
      // without constructing full XDR payloads this assertion does not read.
    } as any);

    expect(outcome).toBe(expected);
  });

  it('reports unknown when the lookup itself fails', async () => {
    const outcome = await fetchGovernanceTxOutcome(TX_HASH, {
      getTransaction: vi.fn(async () => {
        throw new Error('rpc down');
      }),
      // Justification: as above — a throwing one-method stub cannot be typed as
      // the SDK's GetTransactionResponse union.
    } as any);

    expect(outcome).toBe('unknown');
  });

  it('clears a reconciled pending entry once the network settles it', async () => {
    const notFound = makeRpcStub({
      getTransaction: vi.fn(async () => ({ status: rpc.Api.GetTransactionStatus.NOT_FOUND })),
    });
    await submitGovernanceMutation({
      prepared: prepared,
      signTx: vi.fn(async () => signedXdr),
      attempts: 1,
      intervalMs: 1,
      rpcServer: notFound,
      sleep: async () => {},
    }).catch(() => undefined);
    expect(getPendingTransactions()).toHaveLength(1);

    const outcome = await fetchGovernanceTxOutcome(TX_HASH, {
      getTransaction: vi.fn(async () => ({ status: rpc.Api.GetTransactionStatus.SUCCESS })),
      // Justification: as above — a one-method stub for a Pick<rpc.Server, …>.
    } as any);

    expect(outcome).toBe('confirmed');
    expect(getPendingTransactions()).toHaveLength(0);
  });
});

// ─── Contract boundary ────────────────────────────────────────────────────────

describe('governance contract boundary', () => {
  it('declares an arity for every mutation method', () => {
    const methods: GovernanceMutationMethod[] = [
      'cast_vote',
      'create_proposal',
      'execute_proposal',
      'veto_proposal',
    ];

    for (const method of methods) {
      expect(GOVERNANCE_MUTATION_ARITY[method]).toBeGreaterThan(0);
    }
  });

  it('keeps cast_vote pinned to the signing-preview allowlist shape', () => {
    // `cast_vote(voter, proposal_id, choice)` is the one governance signature
    // confirmed by src/utils/transactionPattern.ts and the mock-closure audit.
    // A change here without a matching contract change would have users
    // signing a payload the preview flags as a mismatch.
    expect(GOVERNANCE_MUTATION_ARITY.cast_vote).toBe(3);
  });
});
