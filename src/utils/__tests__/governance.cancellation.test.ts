/**
 * Cancellation-without-mutation tests for #1144 (governance write paths).
 *
 * A declined signature or closed wallet must leave every piece of local
 * governance state untouched: no tally change, no status change, no veto
 * record, no appended proposal.
 *
 * Since #1044/#1045 the guarantee is stronger than "only a collected
 * signature may mutate": the signature is collected from a *simulated* real
 * transaction, and only a network-**confirmed** one updates anything. These
 * tests cover both of the ways a write can stop short of that — the wallet
 * declining, and the network refusing — and assert neither leaves a trace.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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
  vetoProposal,
  clearGovernanceIdempotencyCache,
  type CreateProposalPayload,
} from '../governance';
import { isValidTxHash } from '../explorer';
import {
  createGovernanceRpcStub,
  decliningSignTx,
  governanceWriteOptions,
  passthroughSignTx,
} from '@/test-utils/governance-rpc';

const SIGNER = 'GD2HBFZSXTH4UCKZUVME665WBIPLRBPDTOTYWFRBCKZSFTP7PK46JYSK';

beforeEach(async () => {
  clearGovernanceIdempotencyCache();
  const { rpc } = await import('@stellar/stellar-sdk');
  vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockRejectedValue(new Error('offline'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('governance cancellation leaves state unchanged', () => {
  it('castVote does not record or tally when signing is declined', async () => {
    const stub = createGovernanceRpcStub();
    const before = await fetchProposal(1);

    await expect(
      castVote(1, 'For', SIGNER, decliningSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/USER_REJECTED/i);

    const after = await fetchProposal(1);
    expect(after?.userVote).toBe(before?.userVote);
    expect(after?.votesFor).toBe(before?.votesFor);
    // A declined signature must never reach the network.
    expect(stub.sendTransaction).not.toHaveBeenCalled();
  });

  it('executeProposal keeps status when signing is declined', async () => {
    const stub = createGovernanceRpcStub();
    const before = await fetchProposal(2);

    await expect(
      executeProposal(2, SIGNER, decliningSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/USER_REJECTED/i);

    expect((await fetchProposal(2))?.status).toBe(before?.status);
  });

  it('vetoProposal adds no record when signing is declined', async () => {
    const stub = createGovernanceRpcStub();
    const historyBefore = getVetoHistory(3);

    await expect(
      vetoProposal(3, '0xreason', SIGNER, decliningSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/USER_REJECTED/i);

    expect(getVetoHistory(3)).toEqual(historyBefore);
    expect((await fetchProposal(3))?.status).not.toBe('Vetoed');
  });

  it('createProposal appends nothing when signing is declined', async () => {
    const stub = createGovernanceRpcStub();
    const beforeCount = (await fetchProposals()).length;
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Declined proposal',
      description: 'Should never be appended',
      newValueBps: 30,
    };

    await expect(
      createProposal(payload, SIGNER, decliningSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/USER_REJECTED/i);

    expect((await fetchProposals()).length).toBe(beforeCount);
  });

  it('a failed simulation mutates nothing and never asks for a signature', async () => {
    // #1044: the write stops at simulation, so there is nothing to undo.
    const stub = createGovernanceRpcStub({
      simulationError: 'HostError: Error(Contract, #4)',
    });
    const signTx = passthroughSignTx();
    const before = await fetchProposal(1);

    await expect(castVote(1, 'For', SIGNER, signTx, governanceWriteOptions(stub))).rejects.toThrow(
      /SIMULATION_CONTRACT_ERROR/
    );

    expect(signTx).not.toHaveBeenCalled();
    expect((await fetchProposal(1))?.votesFor).toBe(before?.votesFor);
    expect((await fetchProposal(1))?.userVote).toBe(before?.userVote);
  });

  it('an on-chain failure after signing mutates nothing', async () => {
    const stub = createGovernanceRpcStub({ confirmation: 'failed' });
    const before = await fetchProposal(1);

    await expect(
      castVote(1, 'For', SIGNER, passthroughSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/TX_FAILED/);

    expect((await fetchProposal(1))?.userVote).toBe(before?.userVote);
  });

  it('non-cancellation signing errors also mutate nothing', async () => {
    const stub = createGovernanceRpcStub();
    const failingSignTx = vi.fn(async (): Promise<string> => {
      throw new Error('wallet extension crashed');
    });
    const before = await fetchProposal(1);

    await expect(
      castVote(1, 'For', SIGNER, failingSignTx, governanceWriteOptions(stub))
    ).rejects.toThrow(/wallet extension crashed/i);

    expect((await fetchProposal(1))?.votesFor).toBe(before?.votesFor);
  });

  it('a confirmed transaction yields the network hash in explorer-valid form', async () => {
    const stub = createGovernanceRpcStub();
    const signTx = passthroughSignTx();

    const hash = await castVote(6, 'For', SIGNER, signTx, governanceWriteOptions(stub));

    expect(isValidTxHash(hash)).toBe(true);
    expect(hash).toBe(stub.issuedHashes[0]);
    expect(signTx).toHaveBeenCalled();
  });
});
