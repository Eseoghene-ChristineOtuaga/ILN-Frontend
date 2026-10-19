/**
 * Governance query-cache invalidation (#1065).
 *
 * A governance mutation fans out across several cached queries:
 *
 *   - the proposal list (`governanceKeys.proposals`)
 *   - the mutated proposal's detail (`governanceKeys.proposal(id)`)
 *   - the signer's voting power (`governanceKeys.votingPower(address)`)
 *
 * Invalidation is intentionally separate from the mutation itself so it can
 * run only after the network confirms the write. The cancelled / failed /
 * pending paths must not touch the cache — stale data is better than data that
 * pretends a mutation happened.
 *
 * The invalidator is injected (a `QueryClient` satisfies the interface in the
 * app, a spy satisfies it in tests) so this module stays React-free.
 */

import { governanceKeys } from './keys';

/** What a confirmed governance mutation invalidated. */
export interface GovernanceMutationScope {
  /** Proposal that changed, if the mutation targets a specific proposal. */
  proposalId?: number | null;
  /** Signer whose voting power may have changed. */
  voterAddress?: string | null;
}

/**
 * Minimal surface of `QueryClient` used for invalidation. Keeping it narrow
 * makes the dependency explicit and trivially testable.
 */
export interface GovernanceQueryInvalidator {
  invalidateQueries(filters: { queryKey: readonly unknown[] }): Promise<void> | void;
}

/**
 * Query keys that depend on a confirmed governance mutation, in the order they
 * should be refreshed. Always includes the proposals list; detail and voting
 * power are added only when the scope identifies them.
 */
export function governanceInvalidationKeys(
  scope: GovernanceMutationScope = {}
): readonly (readonly unknown[])[] {
  const keys: (readonly unknown[])[] = [governanceKeys.proposals];

  if (typeof scope.proposalId === 'number' && Number.isFinite(scope.proposalId)) {
    keys.push(governanceKeys.proposal(scope.proposalId));
  }
  if (scope.voterAddress) {
    keys.push(governanceKeys.votingPower(scope.voterAddress));
    keys.push(governanceKeys.activity(scope.voterAddress));
  } else {
    keys.push(governanceKeys.activity());
  }

  return keys;
}

/**
 * Refresh every query that depends on a confirmed governance mutation.
 *
 * Only call this from a confirmed-success path. Cancellation, simulation
 * failure, and pending confirmation must leave the cache untouched.
 */
export async function invalidateGovernanceMutationQueries(
  invalidator: GovernanceQueryInvalidator,
  scope: GovernanceMutationScope = {}
): Promise<void> {
  for (const queryKey of governanceInvalidationKeys(scope)) {
    await invalidator.invalidateQueries({ queryKey });
  }
}
