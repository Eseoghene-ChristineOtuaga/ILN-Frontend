/**
 * Governance idempotency and transaction-hash validity (#1146, #1148).
 *
 * Replaying a governance action must not submit a second transaction: a
 * duplicate vote, execution, or veto would apply the action twice on-chain.
 * Since #1044/#1045 the returned hash is the network's own, so these tests
 * assert the replay returns the *same* hash without a further
 * `sendTransaction` — the stub issues a distinct hash per submission, so a
 * cache that silently re-submitted would be caught here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/constants')>();
  return {
    ...actual,
    GOVERNANCE_CONTRACT_CONFIGURED: true,
    GOVERNANCE_CONTRACT_ID: 'CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC',
  };
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  castVote,
  createProposal,
  executeProposal,
  vetoProposal,
  fetchProposal,
  clearGovernanceIdempotencyCache,
  type CreateProposalPayload,
} from '../governance';
import { isValidTxHash } from '../explorer';
import {
  createGovernanceRpcStub,
  governanceWriteOptions,
  passthroughSignTx,
} from '@/test-utils/governance-rpc';

const SIGNER = 'GD2HBFZSXTH4UCKZUVME665WBIPLRBPDTOTYWFRBCKZSFTP7PK46JYSK';

beforeEach(async () => {
  clearGovernanceIdempotencyCache();
  vi.clearAllMocks();
  const { rpc } = await import('@stellar/stellar-sdk');
  vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockRejectedValue(new Error('offline'));
});
  clearGovernanceTestSession,
  establishGovernanceTestSession,
} from './helpers/governanceSession';
import {
  PROPOSAL_CONTEXT,
  PROPOSER,
  passthroughSignTx,
  stubProposalRpc,
} from './helpers/proposalRpc';

afterEach(() => {
  vi.restoreAllMocks();
});

// Governance writes require a valid SEP-10 session (#1076).
beforeEach(() => {
  establishGovernanceTestSession(SIGNER);
});

afterEach(() => {
  clearGovernanceTestSession();
});

describe('governance idempotency and valid transaction hashes (#1146, #1148)', () => {
  describe('castVote idempotency', () => {
    it('returns a valid 64-character hex transaction hash', async () => {
      const stub = createGovernanceRpcStub();

      const hash = await castVote(
        1,
        'For',
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      );

      expect(isValidTxHash(hash)).toBe(true);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('returns the same hash without re-submitting on a retry with the identical choice', async () => {
      const stub = createGovernanceRpcStub();
      const signTx = passthroughSignTx();

      const firstHash = await castVote(1, 'For', SIGNER, signTx, governanceWriteOptions(stub));
      const secondHash = await castVote(1, 'For', SIGNER, signTx, governanceWriteOptions(stub));
    it('returns the same txHash and does not double-count votes on retry with identical choice', async () => {
      // Proposal creation is on-chain now; vote on an existing active proposal.
      const created = { proposalId: 6 };
      const initialProposal = await fetchProposal(created.proposalId);
      const initialVotesFor = initialProposal?.votesFor ?? 0;

      const firstHash = await castVote(created.proposalId, 'For', SIGNER, signTx);
      const afterFirstProposal = await fetchProposal(created.proposalId);
      const votesAfterFirst = afterFirstProposal?.votesFor ?? 0;
      expect(votesAfterFirst).toBe(initialVotesFor + 1250);

      // Retry voting with the same choice (e.g. user retrying a lagged UI action)
      const secondHash = await castVote(created.proposalId, 'For', SIGNER, signTx);
      const afterSecondProposal = await fetchProposal(created.proposalId);

      expect(secondHash).toBe(firstHash);
      // The decisive assertion: one submission, not two.
      expect(stub.sendTransaction).toHaveBeenCalledTimes(1);
      expect(signTx).toHaveBeenCalledTimes(1);
    });

    it('submits a second transaction when the voter switches choice', async () => {
      // A changed vote is a genuinely different on-chain action, so it must
      // not be deduplicated.
      const stub = createGovernanceRpcStub();

      const forHash = await castVote(
        2,
        'For',
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      );
      const againstHash = await castVote(
        2,
        'Against',
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      );

      expect(againstHash).not.toBe(forHash);
      expect(stub.sendTransaction).toHaveBeenCalledTimes(2);
      expect((await fetchProposal(2))?.userVote).toBe('Against');
    });

    it('does not cache an unconfirmed vote, so a retry still submits', async () => {
      // A timed-out vote has an unknown outcome and must not be remembered as
      // confirmed — otherwise a later retry would silently return the stale
      // hash of a transaction that may have failed (#1045).
      const timingOut = createGovernanceRpcStub({ confirmation: 'never' });
      await expect(
        castVote(4, 'For', SIGNER, passthroughSignTx(), governanceWriteOptions(timingOut))
      ).rejects.toThrow(/TX_TIMEOUT/);

      const settling = createGovernanceRpcStub();
      const hash = await castVote(
        4,
        'For',
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(settling)
      );

      expect(isValidTxHash(hash)).toBe(true);
      expect(settling.sendTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('executeProposal idempotency', () => {
    it('returns the existing confirmation on a duplicate execution', async () => {
      const stub = createGovernanceRpcStub();

      const firstHash = await executeProposal(
        3,
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      );
    it('returns a valid 64-char hash and preserves confirmation on duplicate execution', async () => {
      const created = { proposalId: 1 };

      const firstHash = await executeProposal(created.proposalId, SIGNER, signTx);
      expect(isValidTxHash(firstHash)).toBe(true);

      const secondHash = await executeProposal(
        3,
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      );

      expect(secondHash).toBe(firstHash);
      expect(stub.sendTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('vetoProposal idempotency', () => {
    it('returns the existing confirmation on a duplicate identical veto', async () => {
      const stub = createGovernanceRpcStub();
    it('returns a valid 64-char hash and returns existing confirmation on duplicate veto', async () => {
      const created = { proposalId: 2 };

      const reasonHash = '0xidempotent_reason_hash';

      const firstHash = await vetoProposal(
        5,
        reasonHash,
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      );
      expect(isValidTxHash(firstHash)).toBe(true);

      const secondHash = await vetoProposal(
        5,
        reasonHash,
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      );

      expect(secondHash).toBe(firstHash);
      expect(stub.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('submits again for a veto with a different reason hash', async () => {
      const stub = createGovernanceRpcStub();

      const first = await vetoProposal(
        6,
        '0xreason-a',
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      );
      const second = await vetoProposal(
        6,
        '0xreason-b',
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      );

      expect(second).not.toBe(first);
      expect(stub.sendTransaction).toHaveBeenCalledTimes(2);
    });
  });

  describe('createProposal idempotency', () => {
    const payload: CreateProposalPayload = {
      formType: 'MaxDiscountRate',
      title: 'Deduplicated discount proposal',
      description: 'Testing deduplication',
      newValueBps: 500,
    };

    it('deduplicates rapid duplicate submissions with an identical payload', async () => {
      const stub = createGovernanceRpcStub({ proposalId: 77 });

      const firstRes = await createProposal(
        payload,
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      );
      expect(isValidTxHash(firstRes.txHash)).toBe(true);

      const secondRes = await createProposal(
        payload,
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      );

      expect(secondRes.proposalId).toBe(firstRes.proposalId);
      expect(secondRes.txHash).toBe(firstRes.txHash);
      expect(stub.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('does not deduplicate a different payload from the same signer', async () => {
      const stub = createGovernanceRpcStub();

      const first = await createProposal(
        payload,
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      );
      const second = await createProposal(
        { ...payload, newValueBps: 501 },
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      );

      expect(second.txHash).not.toBe(first.txHash);
      expect(stub.sendTransaction).toHaveBeenCalledTimes(2);
    it('deduplicates rapid duplicate proposal submissions with identical payload', async () => {
      const payload: CreateProposalPayload = {
        formType: 'MaxDiscountRate',
        title: 'Deduplicated discount proposal',
        description: 'Testing deduplication of identical submissions',
        newValueBps: 500,
      };
      establishGovernanceTestSession(PROPOSER);
      const rpcStub = stubProposalRpc();
      const proposalSignTx = vi.fn(passthroughSignTx);
      const options = { context: PROPOSAL_CONTEXT };

      try {
        // Concurrent double-submit shares one in-flight transaction.
        const [firstRes, concurrentRes] = await Promise.all([
          createProposal(payload, PROPOSER, proposalSignTx, options),
          createProposal(payload, PROPOSER, proposalSignTx, options),
        ]);
        expect(isValidTxHash(firstRes.txHash)).toBe(true);
        expect(concurrentRes).toEqual(firstRes);

        // Immediate second submission
        const secondRes = await createProposal(payload, PROPOSER, proposalSignTx, options);
        expect(secondRes.proposalId).toBe(firstRes.proposalId);
        expect(secondRes.txHash).toBe(firstRes.txHash);
        expect(proposalSignTx).toHaveBeenCalledTimes(1);
        expect(rpcStub.sendTransaction).toHaveBeenCalledTimes(1);
      } finally {
        rpcStub.restore();
      }
    });
  });
});
