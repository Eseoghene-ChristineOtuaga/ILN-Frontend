/**
 * Deterministic SEP-10 session fixture for governance write-path tests.
 *
 * Every governance mutation is gated behind `requireSep10Session()` (#1076),
 * so a test that expects a mutation to be attempted must first establish a
 * valid session. The fixture uses a fixed expiry far in the future and a
 * per-call token so it never depends on wall-clock flakiness, and
 * {@link clearGovernanceTestSession} tears the session down so tests stay
 * isolated.
 */

import { sep10Session } from '@/lib/sep10Session';
import { nativeToScVal, rpc } from '@stellar/stellar-sdk';
import { vi } from 'vitest';
import { MOCK_PROPOSALS } from '../governance';

let sessionCounter = 0;
let votingPowerSpy: ReturnType<typeof vi.spyOn> | null = null;

export function stubDefaultVotingPower(power = 1250n): void {
  if (votingPowerSpy) return;
  votingPowerSpy = vi
    .spyOn(rpc.Server.prototype, 'simulateTransaction')
    .mockImplementation(async (tx: any) => {
      const op = tx?.operations?.[0];
      if (op?.function === 'get_voting_power') {
        return {
          transactionData: {},
          minResourceFee: '100',
          events: [],
          latestLedger: 1,
          id: '1',
          _parsed: true,
          result: { auth: [], retval: nativeToScVal(power, { type: 'i128' }) },
        } as unknown as rpc.Api.SimulateTransactionResponse;
      }
      if (op?.function === 'list_proposals') {
        return {
          transactionData: {},
          minResourceFee: '100',
          events: [],
          latestLedger: 1,
          id: '1',
          _parsed: true,
          result: {
            auth: [],
            retval: nativeToScVal(
              MOCK_PROPOSALS.map((p) => ({
                id: p.id,
                title: p.title,
                description: p.description,
                type: p.type,
                status: p.status,
                proposer: p.proposer,
                created_at: p.createdAt,
                voting_starts_at: p.votingStartsAt,
                voting_ends_at: p.votingEndsAt,
                votes_for: p.votesFor,
                votes_against: p.votesAgainst,
                quorum_required: p.quorumRequired,
              }))
            ),
          },
        } as unknown as rpc.Api.SimulateTransactionResponse;
      }
      return {
        error: 'offline',
      } as unknown as rpc.Api.SimulateTransactionResponse;
    });
}

export function restoreDefaultVotingPower(): void {
  if (votingPowerSpy) {
    votingPowerSpy.mockRestore();
    votingPowerSpy = null;
  }
}

/** Establish a valid session for `accountId` (defaults to a fixed test account). */
export function establishGovernanceTestSession(
  accountId = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  defaultVotingPower = 1250n
): void {
  sessionCounter += 1;
  sep10Session.setSession({
    token: `governance-test-token-${sessionCounter}`,
    accountId,
    // Far enough out that no test can trip session expiry mid-flight.
    expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    homeDomain: 'iln.test',
  });
  stubDefaultVotingPower(defaultVotingPower);
}

/** Tear down the fixture session between tests. */
export function clearGovernanceTestSession(): void {
  sep10Session.clearSession();
  restoreDefaultVotingPower();
}
