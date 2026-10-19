/**
 * Soroban RPC stub for the `create_proposal` transaction path (#1055).
 *
 * `createProposal` builds, simulates, prepares, signs, submits and polls a real
 * transaction. This fixture answers those RPC calls on `rpc.Server.prototype`
 * so tests exercise the signed path end to end without a network. Only the
 * `create_proposal` simulation succeeds; every other simulation rejects, so
 * read paths behave as they do offline.
 */

import { Account, nativeToScVal, rpc, type Transaction } from '@stellar/stellar-sdk';
import { vi } from 'vitest';
import type { ProposalValidationContext } from '@/lib/governance/contract-schema';
import { FEE_RATE_RANGE, MAX_DISCOUNT_RATE_RANGE } from '@/lib/governance/chain-parameters';

/** A valid ed25519 account ID (all-zero key) usable as a proposer. */
export const PROPOSER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
export const USDC_CONTRACT = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
export const XLM_SAC_CONTRACT = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
export const CREATE_TX_HASH = '9f'.repeat(32);

/** Validation context with no confirmed current rates and USDC accepted. */
export const PROPOSAL_CONTEXT: ProposalValidationContext = {
  feeRateRange: FEE_RATE_RANGE,
  maxDiscountRateRange: MAX_DISCOUNT_RATE_RANGE,
  currentFeeRateBps: null,
  currentMaxDiscountRateBps: null,
  acceptedTokenAddresses: [USDC_CONTRACT],
};

/** Wallet stand-in: returns the prepared envelope it was asked to sign. */
export const passthroughSignTx = (xdr: string) => Promise.resolve(xdr);

function invokedFunction(tx: Transaction): string | null {
  const op = tx.operations[0];
  if (op?.type !== 'invokeHostFunction') return null;
  try {
    return op.func.invokeContract().functionName().toString();
  } catch {
    return null;
  }
}

export interface ProposalRpcStubOptions {
  proposalId?: number;
  txHash?: string;
  /** Final status returned by `pollTransaction`. */
  finalStatus?: 'SUCCESS' | 'FAILED' | 'NOT_FOUND';
  /** Simulation error text for `create_proposal`, e.g. `Error(Contract, #19)`. */
  simulationError?: string;
}

export function stubProposalRpc(options: ProposalRpcStubOptions = {}) {
  const { proposalId = 42, txHash = CREATE_TX_HASH, finalStatus = 'SUCCESS' } = options;

  const getAccount = vi
    .spyOn(rpc.Server.prototype, 'getAccount')
    .mockImplementation(async (address: string) => new Account(address, '1'));

  const simulateTransaction = vi
    .spyOn(rpc.Server.prototype, 'simulateTransaction')
    .mockImplementation(async (tx) => {
      if (invokedFunction(tx as Transaction) !== 'create_proposal') {
        throw new Error('offline');
      }
      if (options.simulationError) {
        return {
          error: options.simulationError,
          events: [],
          latestLedger: 1,
          id: '1',
          _parsed: true,
        } as unknown as rpc.Api.SimulateTransactionResponse;
      }
      return {
        transactionData: {},
        minResourceFee: '100',
        events: [],
        latestLedger: 1,
        id: '1',
        _parsed: true,
        result: { auth: [], retval: nativeToScVal(BigInt(proposalId), { type: 'u64' }) },
      } as unknown as rpc.Api.SimulateTransactionResponse;
    });

  const prepareTransaction = vi
    .spyOn(rpc.Server.prototype, 'prepareTransaction')
    .mockImplementation(async (tx) => tx as Transaction);

  const sendTransaction = vi.spyOn(rpc.Server.prototype, 'sendTransaction').mockResolvedValue({
    status: 'PENDING',
    hash: txHash,
    latestLedger: 1,
    latestLedgerCloseTime: 0,
  } as unknown as rpc.Api.SendTransactionResponse);

  const pollTransaction = vi.spyOn(rpc.Server.prototype, 'pollTransaction').mockResolvedValue(
    (finalStatus === 'SUCCESS'
      ? {
          status: rpc.Api.GetTransactionStatus.SUCCESS,
          ledger: 1234,
          returnValue: nativeToScVal(BigInt(proposalId), { type: 'u64' }),
        }
      : { status: finalStatus }) as unknown as rpc.Api.GetTransactionResponse
  );

  return {
    getAccount,
    simulateTransaction,
    prepareTransaction,
    sendTransaction,
    pollTransaction,
    restore() {
      for (const spy of [
        getAccount,
        simulateTransaction,
        prepareTransaction,
        sendTransaction,
        pollTransaction,
      ]) {
        spy.mockRestore();
      }
    },
  };
}
