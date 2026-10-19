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

let sessionCounter = 0;

/** Establish a valid session for `accountId` (defaults to a fixed test account). */
export function establishGovernanceTestSession(
  accountId = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ'
): void {
  sessionCounter += 1;
  sep10Session.setSession({
    token: `governance-test-token-${sessionCounter}`,
    accountId,
    // Far enough out that no test can trip session expiry mid-flight.
    expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    homeDomain: 'iln.test',
  });
}

/** Tear down the fixture session between tests. */
export function clearGovernanceTestSession(): void {
  sep10Session.clearSession();
}
