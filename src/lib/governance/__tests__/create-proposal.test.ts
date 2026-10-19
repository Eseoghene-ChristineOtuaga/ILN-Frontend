/**
 * Proposal creation transaction (#1055): build → simulate → sign → submit →
 * confirm against `create_proposal`, with an explicit outcome for each stage.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Account,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  type Transaction,
} from '@stellar/stellar-sdk';
import { getPendingTransactions } from '@/lib/pending-transactions';
import {
  CreateProposalError,
  decodeContractError,
  submitCreateProposal,
  type CreateProposalRequest,
  type CreateProposalStage,
} from '../create-proposal';
import { ProposalValidationError, proposalDescriptionHash, toHex } from '../contract-schema';

const GOV = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const PROPOSER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const HASH = 'ab'.repeat(32);

const payload = {
  formType: 'FeeRate' as const,
  title: 'Lower the protocol fee',
  description: 'Reduce the protocol fee to stay competitive with other pools.',
  newValueBps: 20,
};

const context = {
  feeRateRange: { min: 0, max: 10_000 },
  maxDiscountRateRange: { min: 1, max: 5_000 },
  currentFeeRateBps: 30,
  currentMaxDiscountRateBps: null,
  acceptedTokenAddresses: [],
};

function simulationSuccess() {
  return {
    transactionData: {},
    minResourceFee: '100',
    events: [],
    latestLedger: 1,
    id: '1',
    _parsed: true,
    result: { auth: [], retval: nativeToScVal(7n, { type: 'u64' }) },
  } as unknown as rpc.Api.SimulateTransactionResponse;
}

function makeServer() {
  return {
    getAccount: vi.fn(async (address: string) => new Account(address, '10')),
    simulateTransaction: vi.fn(async () => simulationSuccess()),
    prepareTransaction: vi.fn(async (tx: Transaction) => tx),
    sendTransaction: vi.fn(async () => ({ status: 'PENDING', hash: HASH }) as never),
    pollTransaction: vi.fn(
      async () =>
        ({
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 4321,
          returnValue: nativeToScVal(7n, { type: 'u64' }),
        }) as never
    ),
  };
}

function request(overrides: Partial<CreateProposalRequest> = {}) {
  const stages: CreateProposalStage[] = [];
  const server = makeServer();
  const signTx = vi.fn(async (xdr: string) => xdr);
  return {
    stages,
    server,
    signTx,
    req: {
      payload,
      proposer: PROPOSER,
      signTx,
      context,
      server: server as unknown as CreateProposalRequest['server'],
      governanceContractId: GOV,
      networkPassphrase: Networks.TESTNET,
      onStage: (stage: CreateProposalStage) => stages.push(stage),
      pollAttempts: 3,
      ...overrides,
    } satisfies CreateProposalRequest,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('submitCreateProposal – success', () => {
  it('signs and submits create_proposal and returns the id from the chain', async () => {
    const { req, stages, server, signTx } = request();
    const result = await submitCreateProposal(req);

    expect(result).toEqual({
      proposalId: 7,
      txHash: HASH,
      descriptionHash: toHex(await proposalDescriptionHash(payload.title, payload.description)),
      ledger: 4321,
    });
    expect(stages).toEqual([
      'validating',
      'building',
      'simulating',
      'awaiting_signature',
      'submitting',
      'confirming',
      'confirmed',
    ]);

    // The wallet signs the prepared contract invocation, not an intent string.
    expect(signTx).toHaveBeenCalledTimes(1);
    const signed = TransactionBuilder.fromXDR(
      signTx.mock.calls[0][0],
      Networks.TESTNET
    ) as Transaction;
    const op = signed.operations[0];
    expect(op.type).toBe('invokeHostFunction');
    const invoke = (op as { func: { invokeContract(): any } }).func.invokeContract();
    expect(invoke.functionName().toString()).toBe('create_proposal');
    expect(scValToNative(invoke.args()[1])).toEqual(['UpdateFeeRate', 20]);
    expect(scValToNative(invoke.args()[3])).toBe(20n);

    expect(server.sendTransaction).toHaveBeenCalledTimes(1);
    expect(server.pollTransaction).toHaveBeenCalledWith(HASH, { attempts: 3 });
    expect(getPendingTransactions()).toEqual([]);
  });
});

describe('submitCreateProposal – failures', () => {
  it('rejects invalid payloads before any RPC call or signature', async () => {
    const { req, server, signTx } = request({ payload: { ...payload, newValueBps: 30 } });
    const error = await submitCreateProposal(req).catch((e) => e);
    expect(error).toBeInstanceOf(ProposalValidationError);
    expect(error.issues[0].code).toBe('UNCHANGED');
    expect(server.getAccount).not.toHaveBeenCalled();
    expect(signTx).not.toHaveBeenCalled();
  });

  it('decodes contract errors from simulation and never prompts the wallet', async () => {
    const { req, server, signTx } = request();
    server.simulateTransaction.mockResolvedValueOnce({
      error: 'HostError: Error(Contract, #19)',
      events: [],
      latestLedger: 1,
      id: '1',
      _parsed: true,
    } as never);
    const error = await submitCreateProposal(req).catch((e) => e);
    expect(error).toBeInstanceOf(CreateProposalError);
    expect(error).toMatchObject({
      code: 'SIMULATION_FAILED',
      stage: 'simulating',
      details: { contractError: { code: 19, name: 'InsufficientProposerBalance' } },
    });
    expect(error.message).toMatch(/below the minimum required/);
    expect(signTx).not.toHaveBeenCalled();
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it('wraps a simulation transport failure', async () => {
    const { req, server } = request();
    server.simulateTransaction.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expect(submitCreateProposal(req)).rejects.toMatchObject({ code: 'SIMULATION_FAILED' });
  });

  it('reports a declined signature as USER_REJECTED without submitting', async () => {
    const { req, server } = request({
      signTx: vi.fn().mockRejectedValue(new Error('User declined access')),
    });
    await expect(submitCreateProposal(req)).rejects.toMatchObject({
      code: 'USER_REJECTED',
      stage: 'awaiting_signature',
    });
    expect(server.sendTransaction).not.toHaveBeenCalled();
  });

  it('rethrows non-cancellation wallet errors unchanged', async () => {
    const walletError = new Error('Wallet locked');
    const { req } = request({ signTx: vi.fn().mockRejectedValue(walletError) });
    await expect(submitCreateProposal(req)).rejects.toBe(walletError);
  });

  it('reports rejected submissions with the hash', async () => {
    const { req, server } = request();
    server.sendTransaction.mockResolvedValueOnce({ status: 'ERROR', hash: HASH } as never);
    await expect(submitCreateProposal(req)).rejects.toMatchObject({
      code: 'SUBMISSION_FAILED',
      details: { txHash: HASH },
    });
    expect(server.pollTransaction).not.toHaveBeenCalled();
  });

  it('reports a malformed submission response', async () => {
    const { req, server } = request();
    server.sendTransaction.mockResolvedValueOnce({} as never);
    await expect(submitCreateProposal(req)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('reports an on-chain failure and clears the pending entry', async () => {
    const { req, server } = request();
    server.pollTransaction.mockResolvedValueOnce({
      status: rpc.Api.GetTransactionStatus.FAILED,
    } as never);
    await expect(submitCreateProposal(req)).rejects.toMatchObject({
      code: 'TRANSACTION_FAILED',
      stage: 'confirming',
      details: { txHash: HASH },
    });
    expect(getPendingTransactions()).toEqual([]);
  });

  it('keeps the pending entry when confirmation times out', async () => {
    const { req, server, stages } = request();
    server.pollTransaction.mockResolvedValueOnce({
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    } as never);
    await expect(submitCreateProposal(req)).rejects.toMatchObject({ code: 'CONFIRMATION_TIMEOUT' });
    expect(getPendingTransactions().map((tx) => tx.hash)).toEqual([HASH]);
    expect(stages).not.toContain('confirmed');
  });

  it('refuses a confirmed transaction that returned no proposal id', async () => {
    const { req, server } = request();
    server.pollTransaction.mockResolvedValueOnce({
      status: rpc.Api.GetTransactionStatus.SUCCESS,
      ledger: 1,
    } as never);
    await expect(submitCreateProposal(req)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      details: { txHash: HASH },
    });
  });
});

describe('decodeContractError', () => {
  it('parses governance error codes', () => {
    expect(decodeContractError('Error(Contract, #26)')).toEqual({
      code: 26,
      name: 'InvalidProposalDeposit',
    });
    expect(decodeContractError('Error(Contract, #99)')).toEqual({
      code: 99,
      name: 'GovernanceError#99',
    });
    expect(decodeContractError('timeout')).toBeNull();
  });
});
