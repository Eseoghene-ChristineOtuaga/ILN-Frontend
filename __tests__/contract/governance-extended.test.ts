/**
 * Extended governance tests for previously uncovered functions:
 * - executeProposal, vetoProposal, getVetoHistory
 * - getDelegationInfo (all branches)
 * - lookupToken (all branches)
 * - createProposal (MaxDiscountRate, RemoveToken paths)
 * - fetchParameterUpdates
 * - fetchVotesForAddress
 * - timeRemaining (active proposal paths: days+hours, hours+mins, "Ended")
 * - getUserVote
 * - MOCK_PROPOSALS / MOCK_VOTES data
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { rpc, nativeToScVal } from '@stellar/stellar-sdk';
import { server } from '@/mocks/server';

vi.mock('@/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/constants')>();
  return {
    ...actual,
    GOVERNANCE_CONTRACT_CONFIGURED: true,
    GOVERNANCE_CONTRACT_ID: 'CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC',
  };
});

import {
  executeProposal,
  vetoProposal,
  getVetoHistory,
  getDelegationInfo,
  lookupToken,
  createProposal,
  fetchParameterUpdates,
  fetchSignerRotations,
  fetchVotesForAddress,
  fetchProposals,
  fetchProtocolParameters,
  castVote,
  timeRemaining,
  getUserVote,
  MOCK_PROPOSALS,
  MOCK_VOTES,
  type CreateProposalPayload,
  type Proposal,
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

const SIGNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const mockSignTx = vi.fn(async (_xdr: string) => 'signedXDR');

afterEach(() => {
  vi.useRealTimers();
});

describe('governance – executeProposal', () => {
  it('returns the network transaction hash for a confirmed execution', async () => {
    const stub = createGovernanceRpcStub();

    const hash = await executeProposal(
      3,
      SIGNER,
      passthroughSignTx(),
      governanceWriteOptions(stub)
    );

    expect(hash).toBe(stub.issuedHashes[0]);
    // Status is contract-owned: it is re-read, never written locally.
    expect(MOCK_PROPOSALS.find((p) => p.id === 3)?.status).not.toBe('Executed');
  });

  it('surfaces a contract rejection for an unknown proposal before signing', async () => {
    // `Error(Storage, MissingValue)` is what the contract returns for a
    // proposal key that does not exist.
    const stub = createGovernanceRpcStub({
      simulationError: 'HostError: Error(Storage, MissingValue)',
    });
    const signTx = passthroughSignTx();

    await expect(
      executeProposal(9999, SIGNER, signTx, governanceWriteOptions(stub))
    ).rejects.toThrow(/PROPOSAL_NOT_FOUND/);
    expect(signTx).not.toHaveBeenCalled();
  });
});

describe('governance – vetoProposal', () => {
  it('records veto history after the network confirms, without setting status locally', async () => {
    const stub = createGovernanceRpcStub();

    const hash = await vetoProposal(
      1,
      '0xdeadbeef',
      SIGNER,
      passthroughSignTx(),
      governanceWriteOptions(stub)
    );

    expect(hash).toBe(stub.issuedHashes[0]);
    expect(getVetoHistory(1)).toHaveLength(1);
    expect(getVetoHistory(1)[0]).toMatchObject({
      proposalId: 1,
      admin: SIGNER,
      reasonHash: '0xdeadbeef',
    });
    expect(MOCK_PROPOSALS.find((p) => p.id === 1)?.status).not.toBe('Vetoed');
  });

  it('surfaces an unauthorized veto before the wallet is prompted', async () => {
    // The admin-only boundary is enforced by the contract (#1044), so a
    // non-admin wallet is rejected at simulation rather than by UI gating.
    const stub = createGovernanceRpcStub({
      simulationError: 'HostError: Error(Auth, InvalidAction)',
    });
    const signTx = passthroughSignTx();

    await expect(
      vetoProposal(2, '0xreason', SIGNER, signTx, governanceWriteOptions(stub))
    ).rejects.toThrow(/SIMULATION_UNAUTHORIZED/);
    expect(signTx).not.toHaveBeenCalled();
  });
});

describe('governance – getVetoHistory', () => {
  it('returns veto records for a given proposal', () => {
    // The veto from the previous test should be here
    const history = getVetoHistory(1);
    expect(Array.isArray(history)).toBe(true);
  });

  it('returns empty array for proposals with no vetoes', () => {
    const history = getVetoHistory(9999);
    expect(history).toEqual([]);
  });
});

describe('governance – getDelegationInfo', () => {
  // The governance contract exposes no delegation reads yet (Ref: #111), so
  // this reports "no delegation" rather than the per-address figures it used
  // to invent. Asserting the zeroes keeps a fabricated default from creeping
  // back into the voting-power UI.
  it.each(['GABC123', 'GDEF456', 'GUNKNOWN_ADDRESS_EXAMPLE'])(
    'reports no delegation rather than fabricated figures for %s',
    async (address) => {
      const info = await getDelegationInfo(address);

      expect(info.delegatedTo).toBeNull();
      expect(info.delegatedAmount).toBe(0);
      expect(info.incomingDelegations).toBe(0);
    }
  );
});

describe('governance – lookupToken', () => {
  it('rejects invalid Stellar address', async () => {
    await expect(lookupToken('invalid-address')).rejects.toThrow('Invalid Stellar address');
  });

  it('rejects empty string', async () => {
    await expect(lookupToken('')).rejects.toThrow('Invalid Stellar address');
  });

  it('rejects address that does not start with G or C', async () => {
    await expect(lookupToken('X' + 'A'.repeat(55))).rejects.toThrow('Invalid Stellar address');
  });

  it('rejects already accepted tokens', async () => {
    await expect(
      lookupToken('CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75')
    ).rejects.toThrow('already an accepted token');
  });

  it('simulates Soroban read calls and returns token name and symbol on success', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValueOnce({
        error: undefined,
        transactionData:
          {} as unknown as rpc.Api.SimulateTransactionSuccessResponse['transactionData'],
        minResourceFee: '100',
        events: [],
        result: {
          retval: nativeToScVal('Wrapped Bitcoin'),
        },
      } as unknown as rpc.Api.SimulateTransactionResponse)
      .mockResolvedValueOnce({
        error: undefined,
        transactionData:
          {} as unknown as rpc.Api.SimulateTransactionSuccessResponse['transactionData'],
        minResourceFee: '100',
        events: [],
        result: {
          retval: nativeToScVal('wBTC'),
        },
      } as unknown as rpc.Api.SimulateTransactionResponse);

    const token = await lookupToken('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    expect(token.name).toBe('Wrapped Bitcoin');
    expect(token.symbol).toBe('wBTC');
    expect(token.address).toBe('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC');
    mockSimulate.mockRestore();
  });

  it('throws an error without mock fallback if token simulation fails', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValueOnce({
        error: 'Contract error: FeeOnTransferToken',
        transactionData:
          {} as unknown as rpc.Api.SimulateTransactionSuccessResponse['transactionData'],
        minResourceFee: '100',
        events: [],
      } as unknown as rpc.Api.SimulateTransactionResponse)
      .mockResolvedValueOnce({
        error: undefined,
        transactionData:
          {} as unknown as rpc.Api.SimulateTransactionSuccessResponse['transactionData'],
        minResourceFee: '100',
        events: [],
      } as unknown as rpc.Api.SimulateTransactionResponse);

    await expect(
      lookupToken('CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC')
    ).rejects.toThrow('FeeOnTransferToken');
    mockSimulate.mockRestore();
  });
});

describe('governance – createProposal extended paths', () => {
  it.each([
    ['MaxDiscountRate', { formType: 'MaxDiscountRate', newValueBps: 400 } as const, 201],
    [
      'RemoveToken',
      {
        formType: 'RemoveToken',
        removeTokenAddress: 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
      } as const,
      202,
    ],
  ])('submits a %s proposal and returns the contract-assigned id', async (_n, partial, id) => {
    const stub = createGovernanceRpcStub({ proposalId: id });

    const result = await createProposal(
      { title: 'T', description: 'D', ...partial } as CreateProposalPayload,
      SIGNER,
      passthroughSignTx(),
      governanceWriteOptions(stub)
    );

    expect(result.proposalId).toBe(id);
    // The proposal exists on-chain, not in the local fallback array.
    expect(MOCK_PROPOSALS.find((p) => p.id === result.proposalId)).toBeUndefined();
  });

  it('refuses a RemoveToken payload with no target address', async () => {
    const stub = createGovernanceRpcStub();

    await expect(
      createProposal(
        {
          formType: 'RemoveToken',
          title: 'Remove token (missing address)',
          description: 'RemoveToken form submitted without a target address',
        } as CreateProposalPayload,
        SIGNER,
        passthroughSignTx(),
        governanceWriteOptions(stub)
      )
    ).rejects.toThrow(/removeTokenAddress/);
  });
});

describe('governance – fetchParameterUpdates', () => {
  it('returns parameter updates from executed proposals', async () => {
    vi.useFakeTimers();
    const promise = fetchParameterUpdates();
    vi.runAllTimers();
    const updates = await promise;

    expect(Array.isArray(updates)).toBe(true);
    // Should contain updates from executed proposals (4, 7)
    for (const update of updates) {
      expect(update).toHaveProperty('id');
      expect(update).toHaveProperty('proposalId');
      expect(update).toHaveProperty('parameter');
      expect(update).toHaveProperty('label');
      expect(update).toHaveProperty('newValue');
      expect(update).toHaveProperty('updatedAt');
    }
  });

  it('updates are sorted newest first', async () => {
    vi.useFakeTimers();
    const promise = fetchParameterUpdates();
    vi.runAllTimers();
    const updates = await promise;

    for (let i = 1; i < updates.length; i++) {
      expect(updates[i - 1].updatedAt).toBeGreaterThanOrEqual(updates[i].updatedAt);
    }
  });
});

describe('governance – fetchVotesForAddress', () => {
  const MOCK_VOTER = 'GABC123EXAMPLE456789ABC012GHI345JKL678MNO901PQR234STU567VWX890YZ';

  it('returns votes for known mock voter from horizon VoteCast events', async () => {
    server.use(
      http.get('https://horizon-testnet.stellar.org/transactions', () => {
        return HttpResponse.json({
          _embedded: {
            records: [
              {
                successful: true,
                created_at: '2026-08-20T10:00:00Z',
                _embedded: {
                  records: [
                    {
                      type: 'contract',
                      topics: [
                        'VoteCast',
                        '5',
                        'GABC123EXAMPLE456789ABC012GHI345JKL678MNO901PQR234STU567VWX890YZ',
                        'true',
                      ],
                    },
                  ],
                },
              },
            ],
          },
          _links: { next: undefined },
        });
      })
    );

    vi.useFakeTimers();
    const promise = fetchVotesForAddress(MOCK_VOTER);
    vi.runAllTimers();
    const votes = await promise;

    expect(Array.isArray(votes)).toBe(true);
    expect(votes.length).toBeGreaterThan(0);
    expect(votes[0].voter).toBe(MOCK_VOTER);
    expect(votes[0].proposalId).toBe(5);
    expect(votes[0].vote).toBe('For');
    // Should be sorted by timestamp descending
    for (let i = 1; i < votes.length; i++) {
      expect(votes[i - 1].timestamp).toBeGreaterThanOrEqual(votes[i].timestamp);
    }
  });

  it('returns empty array for unknown address', async () => {
    vi.useFakeTimers();
    const promise = fetchVotesForAddress('GUNKNOWN_ADDRESS');
    vi.runAllTimers();
    const votes = await promise;
    expect(votes).toEqual([]);
  });
});

describe('governance – timeRemaining active paths', () => {
  it("returns 'Ended' for active proposal with past end time", () => {
    const now = Math.floor(Date.now() / 1000);
    const proposal: Proposal = {
      id: 100,
      title: 'Test',
      description: 'Test',
      type: 'ParameterUpdate',
      status: 'Active',
      proposer: 'G...',
      createdAt: now - 86400 * 10,
      votingStartsAt: now - 86400 * 10,
      votingEndsAt: now - 1, // ended 1 second ago
      votesFor: 0,
      votesAgainst: 0,
      quorumRequired: 100_000,
    };
    expect(timeRemaining(proposal)).toBe('Ended');
  });

  it('returns days and hours for active proposal with >1 day remaining', () => {
    const now = Math.floor(Date.now() / 1000);
    const proposal: Proposal = {
      id: 101,
      title: 'Test',
      description: 'Test',
      type: 'ParameterUpdate',
      status: 'Active',
      proposer: 'G...',
      createdAt: now - 86400,
      votingStartsAt: now - 86400,
      votingEndsAt: now + 86400 * 3 + 3600 * 5, // 3 days 5 hours from now
      votesFor: 0,
      votesAgainst: 0,
      quorumRequired: 100_000,
    };
    const result = timeRemaining(proposal);
    expect(result).toMatch(/\d+d \d+h remaining/);
  });

  it('returns hours and minutes for active proposal with <1 day remaining', () => {
    const now = Math.floor(Date.now() / 1000);
    const proposal: Proposal = {
      id: 102,
      title: 'Test',
      description: 'Test',
      type: 'ParameterUpdate',
      status: 'Active',
      proposer: 'G...',
      createdAt: now - 86400,
      votingStartsAt: now - 86400,
      votingEndsAt: now + 3600 * 5 + 60 * 30, // 5 hours 30 minutes from now
      votesFor: 0,
      votesAgainst: 0,
      quorumRequired: 100_000,
    };
    const result = timeRemaining(proposal);
    expect(result).toMatch(/\d+h \d+m remaining/);
  });

  it('returns empty string for non-active proposals', () => {
    const now = Math.floor(Date.now() / 1000);
    const proposal: Proposal = {
      id: 103,
      title: 'Test',
      description: 'Test',
      type: 'ParameterUpdate',
      status: 'Rejected',
      proposer: 'G...',
      createdAt: now - 86400,
      votingStartsAt: now - 86400,
      votingEndsAt: now + 86400,
      votesFor: 0,
      votesAgainst: 0,
      quorumRequired: 100_000,
    };
    expect(timeRemaining(proposal)).toBe('');
  });
});

describe('governance – getUserVote', () => {
  it('returns undefined for proposals not voted on', () => {
    expect(getUserVote(99999)).toBeUndefined();
  });

  it('returns the vote choice after a confirmed vote', async () => {
    const stub = createGovernanceRpcStub();

    await castVote(5, 'For', SIGNER, passthroughSignTx(), governanceWriteOptions(stub));

    expect(getUserVote(5)).toBe('For');
  });
});

describe('governance – MOCK_VOTES', () => {
  it('contains vote cast events with required fields', () => {
    expect(Array.isArray(MOCK_VOTES)).toBe(true);
    for (const vote of MOCK_VOTES) {
      expect(vote).toHaveProperty('proposalId');
      expect(vote).toHaveProperty('proposalTitle');
      expect(vote).toHaveProperty('voter');
      expect(vote).toHaveProperty('vote');
      expect(vote).toHaveProperty('weight');
      expect(vote).toHaveProperty('timestamp');
    }
  });
});

describe('governance – fetchProtocolParameters values', () => {
  it('returns correct fee rate', async () => {
    vi.useFakeTimers();
    const promise = fetchProtocolParameters();
    vi.runAllTimers();
    const params = await promise;
    vi.useRealTimers();
    expect(params.feeRateBps).toBe(50);
  });

  it('returns correct max discount rate', async () => {
    vi.useFakeTimers();
    const promise = fetchProtocolParameters();
    vi.runAllTimers();
    const params = await promise;
    vi.useRealTimers();
    expect(params.maxDiscountRateBps).toBe(500);
  });

  it('returns accepted tokens with USDC and EURC', async () => {
    vi.useFakeTimers();
    const promise = fetchProtocolParameters();
    vi.runAllTimers();
    const params = await promise;
    vi.useRealTimers();
    const symbols = params.acceptedTokens.map((t) => t.symbol);
    expect(symbols).toContain('USDC');
    expect(symbols).toContain('EURC');
  });

  it('returns correct min proposal ILN', async () => {
    vi.useFakeTimers();
    const promise = fetchProtocolParameters();
    vi.runAllTimers();
    const params = await promise;
    vi.useRealTimers();
    expect(params.minProposalILN).toBe(500);
  });
});

// The blocks that asserted locally-built `parameterChanges` and the
// Math.random() transaction-hash fallback were removed with the mock write
// path (#1141, #1044, #1045): createProposal no longer constructs a display
// record, and no hash is ever derived locally. Parameter-change rendering is
// now covered from contract reads in `fetchParameterUpdates` below.

describe('governance – castVote / executeProposal preflight guards', () => {
  it('refuses a vote with no connected wallet instead of inventing a hash', async () => {
    const stub = createGovernanceRpcStub();

    await expect(
      castVote(1, 'For', '', passthroughSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/SOURCE_ACCOUNT_MISSING/);
    expect(stub.sendTransaction).not.toHaveBeenCalled();
  });

  it('refuses an execution with no connected wallet', async () => {
    const stub = createGovernanceRpcStub();

    await expect(
      executeProposal(6, '', passthroughSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/SOURCE_ACCOUNT_MISSING/);
    expect(stub.sendTransaction).not.toHaveBeenCalled();
  });

  it('reports an unfunded source account distinctly from a contract error', async () => {
    const stub = createGovernanceRpcStub({ sequence: null });

    await expect(
      castVote(1, 'For', SIGNER, passthroughSignTx(), governanceWriteOptions(stub))
    ).rejects.toThrow(/SOURCE_ACCOUNT_MISSING/);
  });
});

describe('governance – fetchParameterUpdates executableAfter fallback', () => {
  it('falls back to votingEndsAt as updatedAt when an executed proposal has no executableAfter', async () => {
    // executeProposal no longer flips a local status (#1044, #1045), so the
    // condition is set up directly on the read-only fallback data instead.
    const target = MOCK_PROPOSALS.find((p) => p.status === 'Active')!;
    const originalStatus = target.status;
    const originalExecutableAfter = target.executableAfter;
    target.status = 'Executed';
    target.executableAfter = undefined;

    try {
      const updates = await fetchParameterUpdates();
      const update = updates.find((u) => u.proposalId === target.id);

      expect(update).toBeDefined();
      expect(update!.updatedAt).toBe(target.votingEndsAt);
    } finally {
      target.status = originalStatus;
      target.executableAfter = originalExecutableAfter;
    }
  });
});

describe('governance – fetchProposals session state', () => {
  it('includes userVote from a confirmed on-chain vote', async () => {
    const stub = createGovernanceRpcStub();
    await castVote(3, 'For', SIGNER, passthroughSignTx(), governanceWriteOptions(stub));

    const proposals = await fetchProposals();

    expect(proposals.find((p) => p.id === 3)?.userVote).toBe('For');
  });

  it('proposal without a user vote has undefined userVote', async () => {
    const proposals = await fetchProposals();

    expect(proposals.find((p) => p.id === 2)?.userVote).toBeUndefined();
  });
});

describe('governance – fetchSignerRotations', () => {
  it('returns default mock signer rotations when Horizon is unavailable', async () => {
    vi.useFakeTimers();
    const promise = fetchSignerRotations();
    vi.runAllTimers();
    const rotations = await promise;
    vi.useRealTimers();

    expect(Array.isArray(rotations)).toBe(true);
    expect(rotations.length).toBeGreaterThan(0);
    expect(rotations[0]).toHaveProperty('id');
    expect(rotations[0]).toHaveProperty('oldSigner');
    expect(rotations[0]).toHaveProperty('newSigner');
    expect(rotations[0]).toHaveProperty('rotatedAt');
    expect(rotations[0]).toHaveProperty('action');
    expect(rotations[0].securityLevel).toBe('critical');

    // Should be sorted descending by timestamp
    for (let i = 1; i < rotations.length; i++) {
      expect(rotations[i - 1].rotatedAt).toBeGreaterThanOrEqual(rotations[i].rotatedAt);
    }
  });

  it('parses SignerRotated events from Horizon transaction stream', async () => {
    server.use(
      http.get('https://horizon-testnet.stellar.org/transactions', () => {
        return HttpResponse.json({
          _embedded: {
            records: [
              {
                successful: true,
                hash: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
                created_at: '2026-08-25T12:00:00Z',
                _embedded: {
                  records: [
                    {
                      type: 'contract',
                      topics: [
                        'SignerRotated',
                        'GCOEF7LMN456OPQ789RST012UVW345XYZ678ABC901DEF234GHI567JKL',
                        'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
                        'Quarterly rotation',
                      ],
                    },
                  ],
                },
              },
            ],
          },
          _links: { next: undefined },
        });
      })
    );

    vi.useFakeTimers();
    const promise = fetchSignerRotations();
    vi.runAllTimers();
    const rotations = await promise;
    vi.useRealTimers();

    expect(Array.isArray(rotations)).toBe(true);
    expect(rotations.length).toBeGreaterThan(0);
    expect(rotations[0].oldSigner).toBe(
      'GCOEF7LMN456OPQ789RST012UVW345XYZ678ABC901DEF234GHI567JKL'
    );
    expect(rotations[0].newSigner).toBe('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF');
    expect(rotations[0].reason).toBe('Quarterly rotation');
    expect(rotations[0].securityLevel).toBe('critical');
  });
});

// ─── Mock-backing detection (#857) ────────────────────────────────────────────
//
// See the matching block in governance.test.ts for how the recorded status
// works. Flip 'mock' → 'real' once the linked issue's implementation lands.

describe('governance – mock-backing detection (extended)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function settle<T>(promise: Promise<T>): Promise<T> {
    await vi.runAllTimersAsync();
    return promise;
  }

  // executeProposal is now 'real' (#1044, #1045): a regression back to a
  // no-network mock fails here.
  it('executeProposal (#840): tx hash provenance and contract boundary usage', async () => {
    const stub = createGovernanceRpcStub({ fixedHash: 'e'.repeat(64) });
    const signTx = passthroughSignTx();
    const report = await detectMockBacking({
      run: () => executeProposal(8, SIGNER, signTx, governanceWriteOptions(stub)),
      boundaries: {
        signTx,
        simulateTransaction: stub.simulateTransaction,
        sendTransaction: stub.sendTransaction,
        getTransaction: stub.getTransaction,
      },
    });
    expectMockBackingStatus('executeProposal', report, 'real');
  });

  it('lookupToken (#845): reaches Soroban RPC or the network', async () => {
    vi.useFakeTimers();
    const simulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockRejectedValue(new Error('offline'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
    const report = await detectMockBacking({
      // Not an accepted or hard-coded "known" token, so a real lookup is required.
      run: () =>
        settle(
          lookupToken('GBQD2MXHXD2SRHRQZRZ5JZ4UNLMTMLZNNDJHCQXIJXE2ANBV5IDWB2XK').catch(
            () => undefined
          )
        ),
      identify: () => undefined,
      boundaries: { network: combineRecorders(simulate, fetchSpy) },
    });
    expectMockBackingStatus('lookupToken', report, 'mock');
  });
});
