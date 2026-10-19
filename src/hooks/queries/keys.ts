/**
 * Centralised React Query key factories.
 *
 * Having every contract query derive its key from one place keeps cache
 * invalidation consistent and avoids the typo-prone scattering of inline
 * `["invoices"]` arrays across the codebase.
 *
 * NOTE: the values returned here intentionally match the literal keys that
 * already existed in the app (e.g. `["invoices"]`, `["invoice", id]`,
 * `["contract-stats"]`) so existing consumers — such as the contract event
 * sync that invalidates `["invoice", id]` — keep matching the same cache
 * entries.
 */

export const invoiceKeys = {
  /** All invoices list. */
  all: ['invoices'] as const,
  /** A single invoice by id. */
  detail: (id: bigint | string | number | null | undefined) => ['invoice', id?.toString()] as const,
  /** Total invoice count (cheap counter used by the homepage ticker). */
  count: ['invoice-count'] as const,
};

export const statsKeys = {
  /** Aggregated protocol stats (volume, funded, paid …). */
  all: ['contract-stats'] as const,
};

export const reputationKeys = {
  detail: (address: string) => ['reputation', address] as const,
  payerScore: (address: string) => ['payer-score', address] as const,
  payerScoresBatch: (addresses: string[]) =>
    ['payer-scores-batch', ...addresses.slice().sort()] as const,
};

export const governanceKeys = {
  /**
   * Everything governed by a confirmed governance mutation. Invalidate this
   * prefix only when every governance query must be refreshed.
   */
  all: ['governance'] as const,
  /** All proposals (list + tallies + statuses). */
  proposals: ['governance', 'proposals'] as const,
  /** A single proposal by id. */
  proposal: (id: bigint | string | number | null | undefined) =>
    ['governance', 'proposal', id?.toString() ?? 'unknown'] as const,
  /** Voting power for an address (changes when balances / delegation change). */
  votingPower: (address: string | null | undefined) =>
    ['governance', 'voting-power', address ?? ''] as const,
  /** Governance activity / vote history for an address (#1047). */
  activity: (address?: string | null | undefined) =>
    ['governance', 'activity', address ?? ''] as const,
  /** Recent `ParameterUpdated` contract events for announcement banners. */
  parameterUpdates: ['parameter-updates'] as const,
};

export const protocolKeys = {
  /** Public protocol status (paused/unpaused). */
  status: ['protocol-status'] as const,
};

export const adminKeys = {
  /** Admin action audit log history. */
  actionHistory: ['admin-action-history'] as const,
};

/**
 * Recommended cache timings per query type. Centralised so the trade-off
 * between freshness and request volume is documented in one place.
 *
 * - `staleTime`: how long data is considered fresh (no background refetch).
 * - `gcTime`: how long unused data stays cached before garbage collection.
 */
export const QUERY_TIMINGS = {
  /** Invoice list — changes often via funding/payment events. */
  invoices: { staleTime: 15_000, gcTime: 5 * 60_000 },
  /** Single invoice detail. */
  invoiceDetail: { staleTime: 30_000, gcTime: 5 * 60_000 },
  /** Cheap invoice counter for the homepage ticker. */
  invoiceCount: { staleTime: 30_000, gcTime: 5 * 60_000 },
  /** Aggregated stats — expensive to compute, tolerate slight staleness. */
  stats: { staleTime: 60_000, gcTime: 10 * 60_000 },
  /** Governance parameter updates — slow-moving. */
  parameterUpdates: { staleTime: 5 * 60_000, gcTime: 30 * 60_000 },
  /** Proposal list — refreshed after every confirmed governance mutation. */
  governanceProposals: { staleTime: 15_000, gcTime: 5 * 60_000 },
  /** Single proposal detail — refreshed after confirmed vote/execute/veto. */
  governanceProposalDetail: { staleTime: 30_000, gcTime: 5 * 60_000 },
  /** Voting power — refreshed after a confirmed vote/delegation mutation. */
  governanceVotingPower: { staleTime: 30_000, gcTime: 5 * 60_000 },
  /** Governance activity / votes — refreshed after a confirmed mutation (#1047). */
  governanceActivity: { staleTime: 30_000, gcTime: 5 * 60_000 },
  /** Reputation score — steady, updated periodically. */
  reputation: { staleTime: 30_000, gcTime: 5 * 60_000 },
  /** Protocol status — critical for maintenance banner, poll frequently. */
  protocolStatus: { staleTime: 15_000, gcTime: 5 * 60_000 },
  /** Admin action history — moderate frequency. */
  adminActions: { staleTime: 30_000, gcTime: 5 * 60_000 },
  /** Single payer score. */
  payerScore: { staleTime: 30_000, gcTime: 5 * 60_000 },
  /** Batch payer scores. */
  payerScores: { staleTime: 30_000, gcTime: 5 * 60_000 },
} as const;
