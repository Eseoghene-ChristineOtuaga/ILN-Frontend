'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import Navbar from '@/components/Navbar';
import VoteProgressBar from '@/components/VoteProgressBar';
import QuorumProgressBar from '@/components/QuorumProgressBar';
import TokenAllowlistPanel from '@/components/governance/TokenAllowlistPanel';
import GovernanceMockStatusBanner from '@/components/governance/GovernanceMockStatusBanner';
import VotingPowerDisplay from '@/components/VotingPowerDisplay';
import ErrorBoundary from '@/components/ErrorBoundary';
import PageHeader from '@/components/PageHeader';
import { useWallet } from '@/context/WalletContext';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import {
  Proposal,
  ProposalStatus,
  fetchProposals,
  getVotingPower,
  timeRemaining,
  totalVotes,
} from '@/utils/governance';

const PAGE_SIZE = 20;
type ProposalFilter = 'Active' | 'Passed' | 'Rejected' | 'Executed' | 'Vetoed';
const FILTERS: ProposalFilter[] = ['Active', 'Passed', 'Rejected', 'Executed', 'Vetoed'];

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ProposalStatus }) {
  const config: Record<ProposalStatus, { color: string; icon: string }> = {
    Active: {
      color: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
      icon: 'fiber_manual_record',
    },
    Passed: { color: 'bg-primary/15 text-primary border-primary/30', icon: 'check_circle' },
    Rejected: { color: 'bg-red-500/15 text-red-500 border-red-500/30', icon: 'cancel' },
    Executed: {
      color: 'bg-purple-500/15 text-purple-500 border-purple-500/30',
      icon: 'rocket_launch',
    },
    Vetoed: { color: 'bg-red-500/15 text-red-500 border-red-500/30', icon: 'gavel' },
  };
  const { color, icon } = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold border ${color}`}
    >
      <span
        className="material-symbols-outlined text-[12px]"
        style={{ fontVariationSettings: "'FILL' 1" }}
      >
        {icon}
      </span>
      {status}
    </span>
  );
}

function displayStatus(status: ProposalStatus): ProposalFilter | ProposalStatus {
  return status;
}

// ─── Type badge ───────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: Proposal['type'] }) {
  const label: Record<Proposal['type'], string> = {
    ParameterUpdate: 'Parameter',
    ProtocolUpgrade: 'Upgrade',
    TextProposal: 'Signal',
  };
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium bg-surface-container-high text-on-surface-variant border border-outline-variant/30">
      {label[type]}
    </span>
  );
}

// ─── Proposal card ────────────────────────────────────────────────────────────

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const total = totalVotes(proposal);
  const remaining = timeRemaining(proposal);
  const proposedValue = proposal.parameterChanges?.[0]?.newValue ?? 'Text proposal';

  return (
    <Link
      href={`/governance/${proposal.id}`}
      className="proposal-card group block rounded-2xl border border-outline-variant/20 bg-surface-container-lowest hover:border-primary/40 hover:shadow-lg transition-all duration-200 p-6"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <TypeBadge type={proposal.type} />
          <StatusBadge status={proposal.status} />
        </div>
        <span className="text-xs text-on-surface-variant shrink-0">#{proposal.id}</span>
      </div>

      <h3 className="text-base font-semibold text-on-surface group-hover:text-primary transition-colors mb-2 leading-snug">
        {proposal.title}
      </h3>
      <div className="mb-3 grid grid-cols-1 gap-2 rounded-xl bg-surface-container p-3 text-xs text-on-surface-variant">
        <div className="flex items-center justify-between gap-3">
          <span>Proposer</span>
          <span className="font-mono text-on-surface">{proposal.proposer}</span>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span>Proposed value</span>
          <span className="font-semibold text-on-surface">{proposedValue}</span>
        </div>
      </div>
      <p className="text-sm text-on-surface-variant line-clamp-2 mb-4 leading-relaxed">
        {proposal.description}
      </p>

      <QuorumProgressBar
        votesCast={total}
        quorumRequired={proposal.quorumRequired}
        className="mb-3"
      />

      <VoteProgressBar
        votesFor={proposal.votesFor}
        votesAgainst={proposal.votesAgainst}
        quorumRequired={proposal.quorumRequired}
        compact
      />

      <div className="flex items-center justify-between mt-4 pt-3 border-t border-outline-variant/10">
        <span className="text-xs text-on-surface-variant">{total.toLocaleString()} ILN voted</span>
        {remaining && (
          <span className="text-xs font-medium text-amber-500 flex items-center gap-1">
            <span className="material-symbols-outlined text-[13px]">schedule</span>
            {remaining}
          </span>
        )}
        {proposal.status === 'Passed' && (
          <span className="text-xs font-medium text-primary flex items-center gap-1">
            <span className="material-symbols-outlined text-[13px]">pending_actions</span>
            Ready to execute
          </span>
        )}
        {proposal.status === 'Executed' && (
          <span className="text-xs font-medium text-purple-500 flex items-center gap-1">
            <span className="material-symbols-outlined text-[13px]">rocket_launch</span>
            Executed
          </span>
        )}
        {proposal.status === 'Vetoed' && (
          <span className="text-xs font-medium text-red-500 flex items-center gap-1">
            <span className="material-symbols-outlined text-[13px]">gavel</span>
            Vetoed
          </span>
        )}
      </div>
    </Link>
  );
}

// ─── Filter tab ───────────────────────────────────────────────────────────────

function FilterTabs({
  active,
  onChange,
  counts,
}: {
  active: ProposalFilter;
  onChange: (f: ProposalFilter) => void;
  counts: Record<ProposalFilter, number>;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {FILTERS.map((f) => (
        <button
          key={f}
          onClick={() => onChange(f)}
          className={`px-4 py-1.5 rounded-full text-sm font-medium transition-colors border ${
            active === f
              ? 'bg-primary text-white border-primary'
              : 'bg-surface-container text-on-surface-variant border-outline-variant/30 hover:border-primary/40 hover:text-primary'
          }`}
        >
          {f}
          <span
            className={`ml-1.5 text-xs ${
              active === f ? 'text-white/70' : 'text-on-surface-variant/60'
            }`}
          >
            {counts[f]}
          </span>
        </button>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GovernancePage() {
  useDocumentTitle({ pageTitle: 'Governance' });
  const { address, isConnected } = useWallet();

  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ProposalFilter>('Active');
  const [page, setPage] = useState(1);
  const [votingPower, setVotingPower] = useState(0);

  const load = useCallback(async () => {
    try {
      const data = await fetchProposals();
      setProposals(data);
      setError(null);
    } catch (err) {
      setProposals([]);
      setError(err instanceof Error ? err.message : 'Governance proposals unavailable');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    // Refresh every 30 s for real-time vote counts
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (!isConnected || !address) {
      setVotingPower(0);
      return;
    }
    getVotingPower(address).then(setVotingPower);
  }, [address, isConnected]);

  const sorted = useMemo(
    () => [...proposals].sort((a, b) => b.createdAt - a.createdAt || b.id - a.id),
    [proposals]
  );
  const filtered = sorted.filter((proposal) => displayStatus(proposal.status) === filter);
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageItems = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const canCreateProposal = isConnected && votingPower > 0;

  const counts = FILTERS.reduce(
    (acc, f) => {
      acc[f] = proposals.filter((proposal) => displayStatus(proposal.status) === f).length;
      return acc;
    },
    {} as Record<ProposalFilter, number>
  );

  return (
    <main className="min-h-screen">
      <Navbar />

      {/* Hero banner */}
      <section className="pt-32 pb-12 px-8 border-b border-outline-variant/10 bg-surface-container-lowest">
        <div className="max-w-7xl mx-auto">
          <PageHeader
            breadcrumbs={[{ label: 'ILN Governance' }]}
            title="Proposals"
            description="Shape the future of the protocol. Review active proposals and cast your vote using your ILN token balance."
            actions={
              canCreateProposal ? (
                <div className="flex items-center gap-3 shrink-0">
                  <Link
                    href="/governance/how-it-works"
                    className="inline-flex items-center gap-2 bg-surface-container text-on-surface-variant px-5 py-3 rounded-xl text-sm font-bold border border-outline-variant/30 hover:border-primary/40 hover:text-primary transition-all"
                  >
                    <span className="material-symbols-outlined text-[18px]">help_outline</span>
                    How it works
                  </Link>
                  <Link
                    href="/governance/new"
                    className="inline-flex items-center gap-2 bg-primary text-white px-5 py-3 rounded-xl text-sm font-bold shadow-md hover:bg-primary/90 active:scale-95 transition-all"
                  >
                    <span className="material-symbols-outlined text-[18px]">add</span>
                    Create Proposal
                  </Link>
                </div>
              ) : (
                <div className="rounded-xl border border-outline-variant/30 px-5 py-3 text-sm text-on-surface-variant">
                  Connect a wallet with ILN voting power to create proposals.
                </div>
              )
            }
          />
        </div>
      </section>

      {/* Main content */}
      <section className="py-12 px-8">
        <div className="max-w-7xl mx-auto">
          {/* Voting Power Display */}
          {isConnected && (
            <div className="mb-8">
              <GovernanceMockStatusBanner action="getVotingPower" />
              <VotingPowerDisplay votingPower={votingPower} />
            </div>
          )}

          {/* Filter tabs */}
          <div className="mb-8">
            <FilterTabs
              active={filter}
              onChange={(next) => {
                setFilter(next);
                setPage(1);
              }}
              counts={counts}
            />
          </div>

          <ErrorBoundary onRetry={() => void load()}>
            {error ? (
              <div className="rounded-2xl border border-error/30 bg-error/10 p-8 text-center" role="alert">
                <span className="material-symbols-outlined text-4xl text-error block mb-2">cloud_off</span>
                <h3 className="text-lg font-bold text-error">Governance Data Unavailable</h3>
                <p className="mt-1 text-sm text-on-surface-variant">
                  {error.includes('GOVERNANCE_READ_UNAVAILABLE')
                    ? 'Proposals could not be loaded from the governance contract. Please try again later.'
                    : error}
                </p>
                <button
                  onClick={() => void load()}
                  className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary/90"
                >
                  Retry
                </button>
              </div>
            ) : loading ? (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="h-64 rounded-2xl bg-surface-container animate-pulse" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="proposal-empty text-center py-24">
                <span className="material-symbols-outlined text-5xl text-on-surface-variant/30 block mb-4">
                  inbox
                </span>
                <p className="text-on-surface-variant">No {filter.toLowerCase()} proposals yet.</p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                  {pageItems.map((p) => (
                    <ProposalCard key={p.id} proposal={p} />
                  ))}
                </div>
                {pageCount > 1 && (
                  <div className="mt-8 flex items-center justify-center gap-3">
                    <button
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                      disabled={page === 1}
                      className="rounded-lg border border-outline-variant/30 px-4 py-2 text-sm font-semibold disabled:opacity-50"
                    >
                      Previous
                    </button>
                    <span className="text-sm text-on-surface-variant">
                      Page {page} of {pageCount}
                    </span>
                    <button
                      onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                      disabled={page === pageCount}
                      className="rounded-lg border border-outline-variant/30 px-4 py-2 text-sm font-semibold disabled:opacity-50"
                    >
                      Next
                    </button>
                  </div>
                )}
              </>
            )}
          </ErrorBoundary>

          <ErrorBoundary onRetry={() => void load()}>
            <TokenAllowlistPanel />
          </ErrorBoundary>
        </div>
      </section>
    </main>
  );
}
