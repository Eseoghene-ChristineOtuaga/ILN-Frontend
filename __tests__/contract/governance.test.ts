/**
 * Contract integration tests for governance functions (castVote, createProposal, etc.)
 *
 * Since #1044/#1045 the write paths are real signed Soroban transactions, so
 * the suite injects a stubbed RPC server rather than relying on a mock
 * implementation inside the module. The governance contract id is mocked as
 * configured, because a write against an unconfigured deployment refuses to
 * run at all — which is itself covered in governance.mutation.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rpc, nativeToScVal } from '@stellar/stellar-sdk';

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
  clearGovernanceIdempotencyCache,
  createProposal,
  fetchProposals,
  getProposals,
  fetchProposal,
  fetchProtocolParameters,
  getVotingPower,
  getUserVote,
  clearGovernanceIdempotencyCache,
  totalVotes,
  votePercent,
  quorumReached,
  timeRemaining,
  formatVotingPower,
  isValidStellarAddress,
  parameterLabel,
  parseProposalStatus,
  parseProposalFromNative,
  simulateProposalEffect,
  MOCK_PROPOSALS,
  type CreateProposalPayload,
} from '@/utils/governance';
import {
  combineRecorders,
  detectMockBacking,
  expectMockBackingStatus,
} from '@/test-utils/mock-detection';
import {
  createGovernanceRpcStub,
  governanceWriteOptions,
  passthroughSignTx,
} from '@/test-utils/governance-rpc';
  clearGovernanceTestSession,
  establishGovernanceTestSession,
} from '@/utils/__tests__/helpers/governanceSession';
import {
  CREATE_TX_HASH,
  PROPOSAL_CONTEXT,
  USDC_CONTRACT,
  XLM_SAC_CONTRACT,
  passthroughSignTx,
  stubProposalRpc,
} from '@/utils/__tests__/helpers/proposalRpc';

const SIGNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const mockSignTx = vi.fn(async (_xdr: string) => 'signedXDR');

describe('governance – castVote', () => {
  it('returns the transaction hash the network issued', async () => {
    const stub = createGovernanceRpcStub();

    const hash = await castVote(
      1,
      'For',
      SIGNER,
      passthroughSignTx(),
      governanceWriteOptions(stub)
    );

    expect(hash).toBe(stub.issuedHashes[0]);
  });

  it("records the user's confirmed vote choice", async () => {
    const stub = createGovernanceRpcStub();

    await castVote(2, 'Against', SIGNER, passthroughSignTx(), governanceWriteOptions(stub));

    expect(getUserVote(2)).toBe('Against');
  });

  it('crosses the full contract boundary: simulate, sign, submit, confirm', async () => {
    const stub = createGovernanceRpcStub();
    const signTx = passthroughSignTx();

    await castVote(6, 'For', SIGNER, signTx, governanceWriteOptions(stub));

    expect(stub.getAccount).toHaveBeenCalledWith(SIGNER);
    expect(stub.simulateTransaction).toHaveBeenCalledTimes(1);
    expect(signTx).toHaveBeenCalledTimes(1);
    expect(stub.sendTransaction).toHaveBeenCalledTimes(1);
    expect(stub.getTransaction).toHaveBeenCalled();
  });

  it('leaves the contract-owned tally alone', async () => {
    // Tallies come from `list_proposals`; a local increment is the fabricated
    // behaviour #1044/#1045 removed.
    const stub = createGovernanceRpcStub();
    const before = MOCK_PROPOSALS.map((p) => [p.votesFor, p.votesAgainst]);

    await castVote(1, 'For', SIGNER, passthroughSignTx(), governanceWriteOptions(stub));

    expect(MOCK_PROPOSALS.map((p) => [p.votesFor, p.votesAgainst])).toEqual(before);
  });
});

describe('governance – fetchProposals & SDK boundary', () => {
  it('calls Soroban list_proposals and parses on-chain response correctly', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValueOnce({
        error: undefined,
        transactionData: {} as any,
        minResourceFee: '100',
        events: [],
        result: {
          retval: nativeToScVal([
            {
              id: 10,
              title: 'On-Chain Governance Proposal',
              description: 'Proposal description from Soroban contract',
              type: { ParameterUpdate: [] },
              status: { Rejected: [] },
              proposer: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
              created_at: 1700000000,
              voting_starts_at: 1700000000,
              voting_ends_at: 1700864000,
              votes_for: 1000,
              votes_against: 2500,
              quorum_required: 500,
            },
          ]),
        },
      } as any);

    const proposals = await fetchProposals();

    expect(mockSimulate).toHaveBeenCalled();
    expect(proposals.length).toBe(1);
    expect(proposals[0].id).toBe(10);
    expect(proposals[0].title).toBe('On-Chain Governance Proposal');
    expect(proposals[0].status).toBe('Rejected');
    expect(proposals[0].type).toBe('ParameterUpdate');
    expect(proposals[0].votesFor).toBe(1000);
    expect(proposals[0].votesAgainst).toBe(2500);

    mockSimulate.mockRestore();
  });

  it('getProposals is an alias to fetchProposals', () => {
    expect(getProposals).toBe(fetchProposals);
  });

  it('returns an array of proposals on fallback', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockRejectedValueOnce(new Error('RPC Connection Error'));
    const proposals = await fetchProposals();
    expect(Array.isArray(proposals)).toBe(true);
    expect(proposals.length).toBeGreaterThan(0);
    mockSimulate.mockRestore();
  });

  it('each proposal has required fields', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockRejectedValueOnce(new Error('Simulate Error'));
    const proposals = await fetchProposals();
    for (const proposal of proposals) {
      expect(proposal).toHaveProperty('id');
      expect(proposal).toHaveProperty('title');
      expect(proposal).toHaveProperty('status');
      expect(proposal).toHaveProperty('votesFor');
      expect(proposal).toHaveProperty('votesAgainst');
    }
    mockSimulate.mockRestore();
  });
});

describe('governance – parseProposalStatus & contract parsers', () => {
  it('maps contract Rejected status correctly', () => {
    expect(parseProposalStatus({ Rejected: [] })).toBe('Rejected');
    expect(parseProposalStatus('Rejected')).toBe('Rejected');
  });

  it('maps other contract enum statuses correctly', () => {
    expect(parseProposalStatus({ Active: [] })).toBe('Active');
    expect(parseProposalStatus({ Passed: [] })).toBe('Passed');
    expect(parseProposalStatus({ Executed: [] })).toBe('Executed');
    expect(parseProposalStatus({ Vetoed: [] })).toBe('Vetoed');
    expect(parseProposalStatus('Active')).toBe('Active');
    expect(parseProposalStatus('Passed')).toBe('Passed');
  });

  it('falls back to Active for unknown status', () => {
    expect(parseProposalStatus('UnknownVal')).toBe('Active');
  });

  it('parseProposalFromNative parses native struct correctly', () => {
    const nativeStruct = {
      id: 42,
      title: 'Upgrade Protocol',
      description: 'Upgrade to v2',
      type: { ProtocolUpgrade: [] },
      status: { Rejected: [] },
      proposer: 'GPROPOSER',
      created_at: 100,
      voting_starts_at: 100,
      voting_ends_at: 200,
      votes_for: 300,
      votes_against: 150,
      quorum_required: 100,
    };
    const parsed = parseProposalFromNative(nativeStruct);
    expect(parsed.id).toBe(42);
    expect(parsed.title).toBe('Upgrade Protocol');
    expect(parsed.type).toBe('ProtocolUpgrade');
    expect(parsed.status).toBe('Rejected');
    expect(parsed.proposer).toBe('GPROPOSER');
  });
});

describe('governance – fetchProposal', () => {
  it('returns a specific proposal by ID', async () => {
    vi.useFakeTimers();
    const p = fetchProposal(1);
    vi.runAllTimers();
    const proposal = await p;
    vi.useRealTimers();
    expect(proposal).not.toBeNull();
    expect(proposal?.id).toBe(1);
  });

  it('returns null for non-existent proposal ID', async () => {
    vi.useFakeTimers();
    const p = fetchProposal(9999);
    vi.runAllTimers();
    const proposal = await p;
    vi.useRealTimers();
    expect(proposal).toBeNull();
  });
});

describe('governance – createProposal', () => {
  it('creates a FeeRate proposal and returns txHash + the contract-assigned id', async () => {
    const stub = createGovernanceRpcStub({ proposalId: 31 });
  let rpcStub: ReturnType<typeof stubProposalRpc>;

  beforeEach(() => {
    clearGovernanceIdempotencyCache();
    establishGovernanceTestSession(SIGNER);
    rpcStub = stubProposalRpc({ proposalId: 12 });
  });

  afterEach(() => {
    rpcStub.restore();
    clearGovernanceTestSession();
  });

  it('creates a FeeRate proposal on-chain and returns txHash + proposalId', async () => {
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Reduce fee to 0.2%',
      description: 'Lower protocol fees for better LP returns',
      newValueBps: 20,
    };

    const result = await createProposal(
      payload,
      SIGNER,
      passthroughSignTx(),
      governanceWriteOptions(stub)
    );

    expect(result.txHash).toBe(stub.issuedHashes[0]);
    expect(result.proposalId).toBe(31);
  });

  it('submits an AddToken proposal without appending a local record', async () => {
    const stub = createGovernanceRpcStub({ proposalId: 32 });
    const result = await createProposal(payload, SIGNER, passthroughSignTx, {
      context: PROPOSAL_CONTEXT,
    });

    expect(result).toEqual({ txHash: CREATE_TX_HASH, proposalId: 12 });
    expect(rpcStub.simulateTransaction).toHaveBeenCalled();
    expect(rpcStub.sendTransaction).toHaveBeenCalledTimes(1);
  });

  it('creates an AddToken proposal without fabricating a local record', async () => {
    const before = MOCK_PROPOSALS.length;
    const payload: CreateProposalPayload = {
      formType: 'AddToken',
      title: 'Add XLM',
      description: 'Add the native asset contract as an accepted token',
      tokenAddress: XLM_SAC_CONTRACT,
      tokenName: 'XLM',
      tokenDecimals: 7,
    };
    const beforeCount = MOCK_PROPOSALS.length;

    const result = await createProposal(
      payload,
      SIGNER,
      passthroughSignTx(),
      governanceWriteOptions(stub)
    );

    expect(result.proposalId).toBe(32);
    // The proposal now lives on-chain; the local array is a read-only
    // fallback and must not grow.
    expect(MOCK_PROPOSALS.length).toBe(beforeCount);
    expect(MOCK_PROPOSALS.find((p) => p.id === result.proposalId)).toBeUndefined();
  });

  it('submits a RemoveToken proposal through the contract boundary', async () => {
    const stub = createGovernanceRpcStub({ proposalId: 33 });
    const result = await createProposal(payload, SIGNER, passthroughSignTx, {
      context: PROPOSAL_CONTEXT,
    });

    expect(result.proposalId).toBe(12);
    expect(MOCK_PROPOSALS).toHaveLength(before);
    expect(MOCK_PROPOSALS.find((p) => p.id === result.proposalId)).toBeUndefined();
  });

  it('surfaces a contract rejection from simulation and submits nothing', async () => {
    rpcStub.restore();
    rpcStub = stubProposalRpc({ simulationError: 'HostError: Error(Contract, #19)' });
    const signTx = vi.fn(passthroughSignTx);
    const payload: CreateProposalPayload = {
      formType: 'RemoveToken',
      title: 'Remove USDC',
      description: 'Remove USDC from the active token set',
      removeTokenAddress: USDC_CONTRACT,
    };

    const result = await createProposal(
      payload,
      SIGNER,
      passthroughSignTx(),
      governanceWriteOptions(stub)
    );

    expect(result.proposalId).toBe(33);
    expect(stub.sendTransaction).toHaveBeenCalledTimes(1);
    await expect(
      createProposal(payload, SIGNER, signTx, { context: PROPOSAL_CONTEXT })
    ).rejects.toMatchObject({
      code: 'SIMULATION_FAILED',
      details: { contractError: { code: 19, name: 'InsufficientProposerBalance' } },
    });
    expect(signTx).not.toHaveBeenCalled();
    expect(rpcStub.sendTransaction).not.toHaveBeenCalled();
  });
});

describe('governance – stateful write paths', () => {
  it('persists only the confirmed userVote, not a synthesised tally', async () => {
    const stub = createGovernanceRpcStub({ proposalId: 41 });
    const proposed = await createProposal(
      {
        formType: 'FeeRate',
        title: 'Isolated vote assertion',
        description: 'Uses a fresh proposal to avoid prior test state drift.',
        newValueBps: 75,
      },
      SIGNER,
      passthroughSignTx(),
      governanceWriteOptions(stub)
    );

    const result = await castVote(
      proposed.proposalId,
      'For',
      SIGNER,
      passthroughSignTx(),
      governanceWriteOptions(stub)
    );

    expect(typeof result).toBe('string');
    expect(getUserVote(proposed.proposalId)).toBe('For');
    // No local proposal record exists to carry a tally — the contract owns it.
    expect(MOCK_PROPOSALS.find((p) => p.id === proposed.proposalId)).toBeUndefined();
  });
});

describe('governance – vote helper functions', () => {
  const proposal = MOCK_PROPOSALS[0];

  it('totalVotes sums votes correctly', () => {
    const total = totalVotes(proposal);
    expect(total).toBe(proposal.votesFor + proposal.votesAgainst);
  });

  it('votePercent returns 0 for zero total', () => {
    expect(votePercent(0, 0)).toBe(0);
  });

  it('votePercent calculates percentage with one decimal', () => {
    expect(votePercent(1, 3)).toBeCloseTo(33.3, 1);
  });

  it('quorumReached returns true when votes meet threshold', () => {
    const mockProposal = {
      ...proposal,
      votesFor: 200_000,
      votesAgainst: 0,
      quorumRequired: 100_000,
    };
    expect(quorumReached(mockProposal)).toBe(true);
  });

  it('quorumReached returns false below threshold', () => {
    const mockProposal = {
      ...proposal,
      votesFor: 10_000,
      votesAgainst: 5_000,
      quorumRequired: 100_000,
    };
    expect(quorumReached(mockProposal)).toBe(false);
  });

  it('timeRemaining returns empty string for non-active proposals', () => {
    const passed = MOCK_PROPOSALS.find((p) => p.status === 'Passed') ?? {
      ...proposal,
      status: 'Passed' as const,
    };
    expect(timeRemaining(passed)).toBe('');
  });

  it('formatVotingPower formats millions correctly', () => {
    expect(formatVotingPower(1_500_000)).toContain('M ILN');
  });

  it('formatVotingPower formats thousands correctly', () => {
    expect(formatVotingPower(2_500)).toContain('K ILN');
  });

  it('formatVotingPower formats small amounts', () => {
    expect(formatVotingPower(500)).toBe('500 ILN');
  });
});

describe('governance – address validation', () => {
  it('accepts valid Stellar G-addresses', () => {
    expect(isValidStellarAddress(SIGNER)).toBe(true);
    expect(isValidStellarAddress('GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBVN')).toBe(
      true
    );
  });

  it('rejects invalid addresses', () => {
    expect(isValidStellarAddress('not-an-address')).toBe(false);
    expect(isValidStellarAddress('')).toBe(false);
    expect(isValidStellarAddress('GABC123')).toBe(false);
    expect(isValidStellarAddress('X' + 'A'.repeat(55))).toBe(false);
  });
});

describe('governance – parameterLabel', () => {
  it('returns human-readable label for known parameters', () => {
    expect(parameterLabel('fee_rate_bps')).toBe('Protocol fee rate');
    expect(parameterLabel('quorum_threshold_bps')).toBe('Quorum threshold');
    expect(parameterLabel('accepted_tokens')).toBe('Accepted tokens');
  });

  it('prettifies unknown parameters by replacing underscores', () => {
    expect(parameterLabel('some_custom_param')).toBe('some custom param');
  });
});

describe('governance – getVotingPower', () => {
  it('returns a positive number', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValueOnce({
        error: undefined,
        transactionData: {} as any,
        minResourceFee: '100',
        events: [],
        result: {
          retval: nativeToScVal(1234),
        },
      } as any);

    const power = await getVotingPower(SIGNER);
    expect(mockSimulate).toHaveBeenCalled();
    mockSimulate.mockRestore();
    expect(typeof power).toBe('number');
    expect(power).toBeGreaterThan(0);
  });

  it('fails closed when the contract simulation is unsuccessful (#1049)', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValueOnce({ error: 'simulation failed' } as any);

    await expect(getVotingPower(SIGNER)).rejects.toThrow(/VOTING_POWER_UNAVAILABLE/);
    mockSimulate.mockRestore();
  });
});

describe('governance – fetchProtocolParameters', () => {
  it('fails with a typed error instead of returning hard-coded parameters', async () => {
    const simulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockRejectedValue(new Error('offline'));
    try {
      await expect(fetchProtocolParameters()).rejects.toMatchObject({
        code: 'CHAIN_PARAMETERS_UNAVAILABLE',
      });
      expect(simulate).toHaveBeenCalled();
    } finally {
      simulate.mockRestore();
    }
  });
});

describe('governance – simulateProposalEffect', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns a result with isContractVerified and estimatedEffect fields', async () => {
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Update Fee Rate',
      description: 'Proposal to update fee rate',
      newValueBps: 300,
    };
    vi.runAllTimersAsync();
    const result = await simulateProposalEffect(payload);
    vi.useRealTimers();
    expect(result).toHaveProperty('isContractVerified');
    expect(result).toHaveProperty('estimatedEffect');
    expect(typeof result.isContractVerified).toBe('boolean');
    expect(typeof result.estimatedEffect).toBe('string');
  });

  it('generates estimate for FeeRate proposals', async () => {
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Update Fee Rate',
      description: 'Test proposal',
      newValueBps: 400,
    };
    vi.runAllTimersAsync();
    const result = await simulateProposalEffect(payload);
    vi.useRealTimers();
    expect(result.estimatedEffect).toContain('fee rate');
    expect(result.estimatedEffect).toContain('4');
  });

  it('generates estimate for MaxDiscountRate proposals', async () => {
    const payload: CreateProposalPayload = {
      formType: 'MaxDiscountRate',
      title: 'Update Discount Rate',
      description: 'Test proposal',
      newValueBps: 600,
    };
    vi.runAllTimersAsync();
    const result = await simulateProposalEffect(payload);
    vi.useRealTimers();
    expect(result.estimatedEffect).toContain('discount rate');
    expect(result.estimatedEffect).toContain('6');
  });

  it('generates estimate for AddToken proposals', async () => {
    const payload: CreateProposalPayload = {
      formType: 'AddToken',
      title: 'Add Token',
      description: 'Test proposal',
      tokenAddress: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      tokenName: 'Wrapped Bitcoin',
    };
    vi.runAllTimersAsync();
    const result = await simulateProposalEffect(payload);
    vi.useRealTimers();
    expect(result.estimatedEffect).toContain('Add');
    expect(result.estimatedEffect).toContain('Wrapped Bitcoin');
  });

  it('generates estimate for RemoveToken proposals', async () => {
    const payload: CreateProposalPayload = {
      formType: 'RemoveToken',
      title: 'Remove Token',
      description: 'Test proposal',
      removeTokenAddress: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    };
    vi.runAllTimersAsync();
    const result = await simulateProposalEffect(payload);
    vi.useRealTimers();
    expect(result.estimatedEffect).toContain('Remove');
  });

  it('includes disclaimer for client-side estimates', async () => {
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Update Fee Rate',
      description: 'Test proposal',
      newValueBps: 250,
    };
    vi.runAllTimersAsync();
    const result = await simulateProposalEffect(payload);
    vi.useRealTimers();
    if (!result.isContractVerified) {
      expect(result.warnings).toBeDefined();
      if (result.warnings) {
        expect(result.warnings.length).toBeGreaterThan(0);
      }
    }
  });
});

// ─── Mock-backing detection (#857) ────────────────────────────────────────────
//
// Each function records its current expected status. While the real
// implementation is still pending the status is 'mock' and the test stays
// green; once the linked issue lands, detection flips and this test fails
// until the status is changed to 'real', from which point a regression back
// to a Math.random()/no-network mock fails here, next to the function.
// Flipping to 'real' may also require stubbing the RPC calls the new
// implementation makes (see docs/testing.md → "Mock-backing detection").

describe('governance – mock-backing detection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Earlier suites in this file vote and create proposals with the same
    // signer; without clearing the confirmation cache the detector's run
    // would short-circuit and never reach the contract boundary.
    clearGovernanceIdempotencyCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function settle<T>(promise: Promise<T>): Promise<T> {
    await vi.runAllTimersAsync();
    return promise;
  }

  // castVote and createProposal are now 'real' (#1044, #1045): they build,
  // simulate, sign, submit and confirm a Soroban transaction. From here a
  // regression back to a Math.random()/no-network mock fails this test.
  //
  // The stub issues one fixed hash so the identifier is stable across the
  // detector's repeated runs — a real network returns the same hash for the
  // same transaction, whereas a Math.random() mock would not.
  it('castVote (#839): tx hash provenance and contract boundary usage', async () => {
    const stub = createGovernanceRpcStub({ fixedHash: 'c'.repeat(64) });
    const signTx = passthroughSignTx();
    const report = await detectMockBacking({
      run: () => castVote(1, 'For', SIGNER, signTx, governanceWriteOptions(stub)),
      boundaries: {
        signTx,
        simulateTransaction: stub.simulateTransaction,
        sendTransaction: stub.sendTransaction,
        getTransaction: stub.getTransaction,
      },
    });
    expectMockBackingStatus('castVote', report, 'real');
  });

  it('createProposal (#841): tx hash provenance and contract boundary usage', async () => {
    const stub = createGovernanceRpcStub({ fixedHash: 'd'.repeat(64), proposalId: 55 });
    const signTx = passthroughSignTx();
  it('createProposal (#841): tx hash provenance and signTx usage', async () => {
    establishGovernanceTestSession(SIGNER);
    const rpcStub = stubProposalRpc();
    const signTx = vi.fn(passthroughSignTx);
    const payload: CreateProposalPayload = {
      formType: 'FeeRate',
      title: 'Mock detection probe',
      description: 'Probe proposal used by the mock-backing detection test.',
      newValueBps: 40,
    };
    const report = await detectMockBacking({
      run: () => createProposal(payload, SIGNER, signTx, governanceWriteOptions(stub)),
      identify: (result) => result.txHash,
      boundaries: {
        signTx,
        simulateTransaction: stub.simulateTransaction,
        sendTransaction: stub.sendTransaction,
      },
    });
    expectMockBackingStatus('createProposal', report, 'real');
    try {
      const report = await detectMockBacking({
        run: () => {
          // settle() runs all timers, which includes the session-expiry timer.
          establishGovernanceTestSession(SIGNER);
          clearGovernanceIdempotencyCache();
          return settle(createProposal(payload, SIGNER, signTx, { context: PROPOSAL_CONTEXT }));
        },
        identify: (result) => result.txHash,
        boundaries: { signTx, network: rpcStub.sendTransaction },
      });
      // Signed, submitted, and identified by the hash the network returned (#1055).
      expectMockBackingStatus('createProposal', report, 'real');
    } finally {
      rpcStub.restore();
      clearGovernanceTestSession();
    }
  });

  it('fetchProtocolParameters (#844): reaches Soroban RPC or the network', async () => {
    const simulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockRejectedValue(new Error('offline'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const report = await detectMockBacking({
      run: () => settle(fetchProtocolParameters().catch(() => undefined)),
      identify: () => undefined,
      boundaries: { network: combineRecorders(simulate, fetchSpy) },
    });
    // Reads governance getters over Soroban RPC; no hard-coded fallback (#1054).
    expectMockBackingStatus('fetchProtocolParameters', report, 'real');
  });
});
