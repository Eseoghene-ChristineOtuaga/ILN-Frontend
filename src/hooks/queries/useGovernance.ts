'use client';

import { useQuery } from '@tanstack/react-query';
import {
  fetchProposal,
  fetchProposals,
  getVotingPower,
  type Proposal,
} from '@/utils/governance';
import { governanceKeys, QUERY_TIMINGS } from './keys';
import { createQueryConfig } from './defaultConfig';

/**
 * Governance proposal list.
 *
 * Shares `governanceKeys.proposals` with
 * {@link invalidateGovernanceMutationQueries}, so a confirmed vote / proposal /
 * veto / execution refreshes the list without a manual refetch.
 */
export function useGovernanceProposals() {
  return useQuery<Proposal[], Error>({
    queryKey: governanceKeys.proposals,
    queryFn: fetchProposals,
    ...createQueryConfig({
      ...QUERY_TIMINGS.governanceProposals,
    }),
  });
}

/** A single governance proposal by id. */
export function useGovernanceProposal(id?: number | null) {
  return useQuery<Proposal | null, Error>({
    queryKey: governanceKeys.proposal(id),
    queryFn: () => fetchProposal(id ?? 0),
    enabled: typeof id === 'number' && Number.isFinite(id),
    ...createQueryConfig({
      ...QUERY_TIMINGS.governanceProposalDetail,
    }),
  });
}

/** Voting power for `address`; disabled until an address is available. */
export function useGovernanceVotingPower(address?: string | null) {
  return useQuery<number, Error>({
    queryKey: governanceKeys.votingPower(address),
    queryFn: () => getVotingPower(address ?? ''),
    enabled: Boolean(address),
    ...createQueryConfig({
      ...QUERY_TIMINGS.governanceVotingPower,
    }),
  });
}
