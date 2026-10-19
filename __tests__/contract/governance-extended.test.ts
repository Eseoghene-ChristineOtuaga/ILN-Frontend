/**
 * Extended governance tests for previously uncovered functions:
 * - executeProposal, vetoProposal, getVetoHistory
 * - getDelegationInfo (all branches)
 * - lookupToken (all branches)
 * - createProposal schema rejections (no local mutation)
 * - fetchParameterUpdates (confirmed contract events)
 * - fetchVotesForAddress
 * - timeRemaining (active proposal paths: days+hours, hours+mins, "Ended")
 * - getUserVote
 * - MOCK_PROPOSALS / MOCK_VOTES data
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { rpc, nativeToScVal } from '@stellar/stellar-sdk';
import { server } from '@/mocks/server';

import {
  executeProposal,
  vetoProposal,
  getVetoHistory,
  getDelegationInfo,
  DelegationError,
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
  clearGovernanceTestSession,
  establishGovernanceTestSession,
} from '@/utils/__tests__/helpers/governanceSession';
import {
  PROPOSAL_CONTEXT,
  USDC_CONTRACT,
  passthroughSignTx,
  stubProposalRpc,
} from '@/utils/__tests__/helpers/proposalRpc';

const SIGNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const mockSignTx = vi.fn(async (_xdr: string) => 'signedXDR');

beforeEach(() => {
  establishGovernanceTestSession(SIGNER);
});

afterEach(() => {
  vi.useRealTimers();
  clearGovernanceTestSession();
});

describe('governance – executeProposal', () => {
  it('returns a transaction hash and sets status to Executed', async () => {
    vi.useFakeTimers();
    const proposalId = 6;
    const promise = executeProposal(proposalId, SIGNER, mockSignTx);
    vi.runAllTimers();
    const hash = await promise;
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
    const proposal = MOCK_PROPOSALS.find((p) => p.id === proposalId);
    expect(proposal?.status).toBe('Executed');
  });

  it('handles non-existent proposal gracefully', async () => {
    vi.useFakeTimers();
    const promise = executeProposal(9999, SIGNER, mockSignTx);
    vi.runAllTimers();
    await expect(promise).rejects.toThrow('Proposal not found');
  });
});

describe('governance – vetoProposal', () => {
  it('sets proposal status to Vetoed and records veto history', async () => {
    vi.useFakeTimers();
    const proposalId = 1;
    const reasonHash = 'abc123reasonhash';
    const adminAddress = 'GADMIN_ADDRESS';
    establishGovernanceTestSession(adminAddress);
    const promise = vetoProposal(proposalId, reasonHash, adminAddress, mockSignTx);
    vi.runAllTimers();
    const hash = await promise;

    expect(typeof hash).toBe('string');
    const proposal = MOCK_PROPOSALS.find((p) => p.id === proposalId);
    expect(proposal?.status).toBe('Vetoed');
    expect(proposal?.vetoHistory).toBeDefined();
    expect(proposal!.vetoHistory!.length).toBeGreaterThan(0);
    expect(proposal!.vetoHistory![0].admin).toBe(adminAddress);
    expect(proposal!.vetoHistory![0].reasonHash).toBe(reasonHash);
  });

  it('throws for non-existent proposal', async () => {
    vi.useFakeTimers();
    establishGovernanceTestSession('GADMIN');
    const promise = vetoProposal(99999, 'reason', 'GADMIN', mockSignTx);
    vi.runAllTimers();
    await expect(promise).rejects.toThrow('Proposal not found');
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
  it('rejects invalid or missing Stellar address with DelegationError', async () => {
    await expect(getDelegationInfo('')).rejects.toThrow(DelegationError);
    await expect(getDelegationInfo('invalid-addr')).rejects.toThrow(DelegationError);
    await expect(getDelegationInfo('invalid-addr')).rejects.toThrow(/DELEGATION_UNAVAILABLE/);
  });

  it('queries contract-backed delegation data with normalized address and amounts', async () => {
    const DELEGATE = 'GBBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEFZSP';
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValueOnce({
        error: undefined,
        transactionData: {} as any,
        minResourceFee: '100',
        events: [],
        result: {
          retval: nativeToScVal({
            delegate: DELEGATE,
            amount: 500_0000000n,
            incoming: 1200_0000000n,
          }),
        },
      } as any);

    const info = await getDelegationInfo(SIGNER);
    expect(mockSimulate).toHaveBeenCalledTimes(1);
    expect(info.delegatedTo).toBe(DELEGATE);
    expect(info.delegatedAmount).toBe(500);
    expect(info.incomingDelegations).toBe(1200);
    mockSimulate.mockRestore();
  });

  it('handles undelegated response from contract', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValueOnce({
        error: undefined,
        transactionData: {} as any,
        minResourceFee: '100',
        events: [],
        result: {
          retval: nativeToScVal({
            delegate: 'none',
            amount: 0n,
            incoming: 0n,
          }),
        },
      } as any);

    const info = await getDelegationInfo(SIGNER);
    expect(info.delegatedTo).toBeNull();
    expect(info.delegatedAmount).toBe(0);
    expect(info.incomingDelegations).toBe(0);
    mockSimulate.mockRestore();
  });

  it('fails closed and throws DelegationError when contract simulation fails', async () => {
    const mockSimulate = vi
      .spyOn(rpc.Server.prototype, 'simulateTransaction')
      .mockResolvedValueOnce({
        error: 'Simulation failed: host error',
      } as any);

    await expect(getDelegationInfo(SIGNER)).rejects.toThrow(DelegationError);
    await expect(getDelegationInfo(SIGNER)).rejects.toThrow(/DELEGATION_UNAVAILABLE/);
    mockSimulate.mockRestore();
  });
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
      lookupToken(USDC_CONTRACT, [
        { address: USDC_CONTRACT, name: 'USD Coin', symbol: 'USDC', decimals: 7 },
      ])
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
      } as unknown as rpc.Api.SimulateTransactionResponse)
      .mockResolvedValueOnce({
        error: undefined,
        transactionData:
          {} as unknown as rpc.Api.SimulateTransactionSuccessResponse['transactionData'],
        minResourceFee: '100',
        events: [],
        result: {
          retval: nativeToScVal(8, { type: 'u32' }),
        },
      } as unknown as rpc.Api.SimulateTransactionResponse);

    const token = await lookupToken('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', []);
    expect(token.name).toBe('Wrapped Bitcoin');
    expect(token.symbol).toBe('wBTC');
    expect(token.decimals).toBe(8);
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
      } as unknown as rpc.Api.SimulateTransactionResponse)
      .mockResolvedValueOnce({
        error: undefined,
        transactionData:
          {} as unknown as rpc.Api.SimulateTransactionSuccessResponse['transactionData'],
        minResourceFee: '100',
        events: [],
      } as unknown as rpc.Api.SimulateTransactionResponse);

    await expect(
      lookupToken('CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC', [])
    ).rejects.toThrow('FeeOnTransferToken');
    mockSimulate.mockRestore();
  });
});

describe('governance – createProposal schema rejections', () => {
  // Invalid payloads are rejected before any RPC call, signature or local
  // write: there is no mock proposal to fall back to (#1055, #1056).
  let rpcStub: ReturnType<typeof stubProposalRpc>;

  beforeEach(() => {
    establishGovernanceTestSession(SIGNER);
    rpcStub = stubProposalRpc();
  });

  afterEach(() => {
    rpcStub.restore();
    clearGovernanceTestSession();
  });

  const invalid: Array<[string, CreateProposalPayload, string]> = [
    [
      'MaxDiscountRate above the invoice contract limit',
      {
        formType: 'MaxDiscountRate',
        title: 'Raise max discount',
        description: 'Raise the max discount above what invoices accept',
        newValueBps: 6_000,
      },
      'OUT_OF_RANGE',
    ],
    [
      'RemoveToken for a token that is not accepted',
      {
        formType: 'RemoveToken',
        title: 'Remove Unknown',
        description: 'Remove a token that is not in the allowlist',
        removeTokenAddress: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      },
      'NOT_ACCEPTED',
    ],
    [
      'RemoveToken without a target',
      {
        formType: 'RemoveToken',
        title: 'Remove token (missing address)',
        description: 'RemoveToken form submitted without a target address',
      },
      'REQUIRED',
    ],
    [
      'AddToken with an account address',
      {
        formType: 'AddToken',
        title: 'Add account',
        description: 'An account address is not a token contract',
        tokenAddress: SIGNER,
        tokenDecimals: 7,
      },
      'INVALID_CONTRACT_ADDRESS',
    ],
    [
      'AddToken whose decimals were never read',
      {
        formType: 'AddToken',
        title: 'Add unnamed token',
        description: 'Add a token without resolving its decimals first',
        tokenAddress: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      },
      'DECIMALS_UNRESOLVED',
    ],
  ];

  it.each(invalid)('rejects %s', async (_name, payload, code) => {
    const before = MOCK_PROPOSALS.length;
    const signTx = vi.fn(passthroughSignTx);
    const error = await createProposal(payload, SIGNER, signTx, {
      context: PROPOSAL_CONTEXT,
    }).catch((e) => e);

    expect(error.code).toBe('PROPOSAL_VALIDATION_FAILED');
    expect(error.issues.map((i: { code: string }) => i.code)).toContain(code);
    expect(rpcStub.getAccount).not.toHaveBeenCalled();
    expect(signTx).not.toHaveBeenCalled();
    expect(MOCK_PROPOSALS.length).toBe(before);
  });
});

describe('governance – fetchParameterUpdates', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns only confirmed contract events', async () => {
    vi.spyOn(rpc.Server.prototype, 'getLatestLedger').mockResolvedValue({
      sequence: 50_000,
    } as never);
    const getEvents = vi.spyOn(rpc.Server.prototype, 'getEvents').mockResolvedValue({
      events: [],
      cursor: '',
      latestLedger: 50_000,
    } as never);

    const updates = await fetchParameterUpdates();

    expect(updates).toEqual([]);
    expect(getEvents).toHaveBeenCalledTimes(1);
    expect(MOCK_PROPOSALS.some((p) => p.status === 'Executed')).toBe(true);
  });

  it('throws when RPC cannot answer instead of deriving updates from local proposals', async () => {
    vi.spyOn(rpc.Server.prototype, 'getLatestLedger').mockRejectedValue(new Error('offline'));
    await expect(fetchParameterUpdates()).rejects.toMatchObject({
      code: 'PARAMETER_EVENTS_UNAVAILABLE',
    });
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

  it('returns the vote choice after casting', async () => {
    vi.useFakeTimers();
    const promise = castVote(5, 'For', SIGNER, mockSignTx);
    vi.runAllTimers();
    await promise;
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
  it('reads the governance getters and does not return the old 50 / 500 / 500 constants', async () => {
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

describe('governance – castVote / executeProposal branch edge cases', () => {
  it('castVote skips vote-tally update for a non-existent proposal but still returns a hash', async () => {
    vi.useFakeTimers();
    const promise = castVote(9999, 'For', SIGNER, mockSignTx);
    vi.runAllTimers();
    const hash = await promise;
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
    // No matching proposal exists, so nothing to assert on vote tallies —
    // the important behavior is that it doesn't throw and still returns a hash.
  });

  it('castVote skips the on-chain attempt entirely when signerAddress is empty', async () => {
    vi.useFakeTimers();
    const promise = castVote(1, 'For', '', mockSignTx);
    vi.runAllTimers();
    const hash = await promise;
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });

  it('executeProposal skips the on-chain attempt entirely when signerAddress is empty', async () => {
    vi.useFakeTimers();
    const promise = executeProposal(6, '', mockSignTx);
    vi.runAllTimers();
    const hash = await promise;
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });
});

describe('governance – fetchProposals session state', () => {
  it('includes userVote from session state', async () => {
    vi.useFakeTimers();
    const votePromise = castVote(3, 'For', SIGNER, mockSignTx);
    vi.runAllTimers();
    await votePromise;

    const proposalPromise = fetchProposals();
    vi.runAllTimers();
    const proposals = await proposalPromise;
    vi.useRealTimers();

    const proposal = proposals.find((p) => p.id === 3);
    expect(proposal?.userVote).toBe('For');
  });

  it('proposal without user vote has undefined userVote', async () => {
    vi.useFakeTimers();
    const proposalPromise = fetchProposals();
    vi.runAllTimers();
    const proposals = await proposalPromise;
    vi.useRealTimers();

    const proposal = proposals.find((p) => p.id === 2);
    expect(proposal?.userVote).toBeUndefined();
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

  it('executeProposal (#840): tx hash provenance and signTx usage', async () => {
    vi.useFakeTimers();
    const signTx = vi.fn(async (_xdr: string) => 'signedXDR');
    const report = await detectMockBacking({
      run: () => settle(executeProposal(6, SIGNER, signTx)),
      boundaries: { signTx },
    });
    expectMockBackingStatus('executeProposal', report, 'mock');
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
