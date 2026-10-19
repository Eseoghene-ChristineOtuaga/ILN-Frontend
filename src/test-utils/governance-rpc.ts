/**
 * Shared RPC harness for the governance write pipeline (#1044, #1045).
 *
 * Governance mutations are now real signed Soroban transactions, so their
 * tests need a network to talk to. This provides one stub that every
 * governance suite injects via the `rpcServer` write option, which keeps each
 * test about the behaviour it is asserting rather than about XDR plumbing.
 *
 * Note that `signTx` here returns the unsigned XDR unchanged. That is a
 * genuine, parseable transaction envelope — which is what the pipeline needs
 * in order to round-trip it through `TransactionBuilder.fromXDR` — without
 * requiring a keypair.
 */
import { vi } from 'vitest';
import { nativeToScVal, rpc, Account, SorobanDataBuilder, xdr } from '@stellar/stellar-sdk';
import type { GovernanceWriteOptions } from '@/utils/governance';

/** How the stubbed network should settle a submitted transaction. */
export type GovernanceConfirmationMode =
  /** RPC reports SUCCESS on the first poll. */
  | 'success'
  /** RPC reports FAILED on the first poll. */
  | 'failed'
  /** RPC never settles it, so the confirmation bound is reached (#1045). */
  | 'never';

export interface GovernanceRpcStubOptions {
  /** Proposal id the stubbed `create_proposal` returns. */
  proposalId?: number;
  confirmation?: GovernanceConfirmationMode;
  /** Simulation error string to return instead of a success (#1044). */
  simulationError?: string;
  /** Account sequence number; `getAccount` throws when this is null. */
  sequence?: string | null;
  /**
   * Return this hash for every submission instead of a distinct one.
   *
   * Needed by the mock-backing detection suite, which runs the function
   * several times and treats an identifier that changes between identical
   * runs as evidence of a non-deterministic (mock) source.
   */
  fixedHash?: string;
}

export interface GovernanceRpcStub {
  getAccount: ReturnType<typeof vi.fn>;
  simulateTransaction: ReturnType<typeof vi.fn>;
  sendTransaction: ReturnType<typeof vi.fn>;
  getTransaction: ReturnType<typeof vi.fn>;
  /** Hashes handed out by `sendTransaction`, in order. */
  issuedHashes: string[];
}

const SOURCE = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

/**
 * Deterministic but *distinct* 64-hex hash per submission.
 *
 * Distinctness matters: an idempotency test that asserts "the replay returned
 * the same hash" would pass vacuously against a stub that always returns one
 * constant, proving nothing about the cache.
 */
function hashForSubmission(index: number): string {
  return index.toString(16).padStart(64, '0');
}

/** Parsed-shape simulation success, matching what `rpc.Server` returns. */
export function governanceSimulationSuccess(retval?: xdr.ScVal) {
  return {
    _parsed: true,
    id: 'sim',
    latestLedger: 100,
    events: [],
    transactionData: new SorobanDataBuilder(),
    minResourceFee: '1000',
    result: { auth: [], retval: retval ?? nativeToScVal(1, { type: 'u64' }) },
  };
}

export function createGovernanceRpcStub(options: GovernanceRpcStubOptions = {}): GovernanceRpcStub {
  const {
    proposalId = 101,
    confirmation = 'success',
    simulationError,
    sequence = '42',
    fixedHash,
  } = options;

  const issuedHashes: string[] = [];

  const stub: GovernanceRpcStub = {
    getAccount: vi.fn(async () => {
      if (sequence === null) throw new Error('Account not found');
      return new Account(SOURCE, sequence);
    }),

    simulateTransaction: vi.fn(async () => {
      if (simulationError) {
        return { _parsed: true, id: 'sim', latestLedger: 1, events: [], error: simulationError };
      }
      // Every mutation is simulated; `create_proposal` is the only one whose
      // return value the caller reads, so returning the id unconditionally is
      // harmless and keeps the stub simple.
      return governanceSimulationSuccess(nativeToScVal(proposalId, { type: 'u64' }));
    }),

    sendTransaction: vi.fn(async () => {
      const hash = fixedHash ?? hashForSubmission(issuedHashes.length + 1);
      issuedHashes.push(hash);
      return { hash, status: 'PENDING' };
    }),

    getTransaction: vi.fn(async () => {
      if (confirmation === 'failed') {
        return { status: rpc.Api.GetTransactionStatus.FAILED };
      }
      if (confirmation === 'never') {
        return { status: rpc.Api.GetTransactionStatus.NOT_FOUND };
      }
      return {
        status: rpc.Api.GetTransactionStatus.SUCCESS,
        ledger: 999,
        returnValue: nativeToScVal(proposalId, { type: 'u64' }),
      };
    }),

    issuedHashes,
  };

  return stub;
}

/**
 * Write options that drive the pipeline deterministically: the stubbed
 * network, no real sleeping between polls, and a small attempt bound so a
 * timeout case resolves immediately.
 */
export function governanceWriteOptions(stub: GovernanceRpcStub): GovernanceWriteOptions {
  return {
    // The stub implements exactly the four `rpc.Server` methods the pipeline's
    // `Pick<rpc.Server, …>` parameter names, so this is structurally sound; the
    // vi.fn() signatures are looser than the SDK's response unions, which is
    // what the double assertion bridges.
    rpcServer: stub as unknown as GovernanceWriteOptions['rpcServer'],
    sleep: async () => {},
    attempts: 3,
    intervalMs: 1,
  };
}

/** Signs by returning the unsigned envelope — valid, parseable XDR. */
export const passthroughSignTx = (impl?: () => void) =>
  vi.fn(async (txXdr: string) => {
    impl?.();
    return txXdr;
  });

/** A wallet that declines the signature. */
export const decliningSignTx = () =>
  vi.fn(async (_txXdr: string): Promise<string> => {
    throw new Error('User rejected the transaction');
  });
