'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import Navbar from '@/components/Navbar';
import VoteSection from '@/components/VoteSection';
import GovernanceMockStatusBanner from '@/components/governance/GovernanceMockStatusBanner';
import { GOVERNANCE_ADMIN_ADDRESS } from '@/constants';
import { useWallet } from '@/context/WalletContext';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { useTransaction } from '@/hooks/useTransaction';
import { hashEvidence } from '@/utils/evidence';
import {
  Proposal,
  ProposalStatus,
  VoteChoice,
  castVote,
  executeProposal,
  fetchProposal,
  formatVotingPower,
  getVotingPower,
  timeRemaining,
  vetoProposal,
} from '@/utils/governance';

function formatRelativeCountdown(seconds: number): string {
  if (seconds <= 0) return 'Ready to execute';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h remaining`;
  if (hours > 0) return `${hours}h ${minutes}m remaining`;
  return `${minutes}m remaining`;
}

function executionEffect(proposal: Proposal): string | null {
  if (!proposal.parameterChanges?.length) return null;
  if (proposal.parameterChanges.length === 1) {
    const change = proposal.parameterChanges[0];
    return `${change.parameter.replace(/_/g, ' ')} updated to ${change.newValue}`;
  }
  return `${proposal.parameterChanges.length} protocol parameters were updated.`;
}

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
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-semibold border ${color}`}
    >
      <span
        className="material-symbols-outlined text-[14px]"
        style={{ fontVariationSettings: "'FILL' 1" }}
      >
        {icon}
      </span>
      {status}
    </span>
  );
}

// ─── Proposal type label ──────────────────────────────────────────────────────

function TypePill({ type }: { type: Proposal['type'] }) {
  const label: Record<Proposal['type'], { text: string; icon: string }> = {
    ParameterUpdate: { text: 'Parameter Update', icon: 'tune' },
    ProtocolUpgrade: { text: 'Protocol Upgrade', icon: 'upgrade' },
    TextProposal: { text: 'Signal / Text', icon: 'record_voice_over' },
  };
  const { text, icon } = label[type];
  return (
    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium bg-surface-container text-on-surface-variant border border-outline-variant/30">
      <span className="material-symbols-outlined text-[14px]">{icon}</span>
      {text}
    </span>
  );
}

// ─── Parameter change table ───────────────────────────────────────────────────

function ParameterChangeTable({ changes }: { changes: NonNullable<Proposal['parameterChanges']> }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-outline-variant/20">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-surface-container text-on-surface-variant">
            <th className="text-left px-4 py-3 font-semibold">Parameter</th>
            <th className="text-left px-4 py-3 font-semibold">Current Value</th>
            <th className="text-left px-4 py-3 font-semibold">Proposed Value</th>
          </tr>
        </thead>
        <tbody>
          {changes.map((c, i) => (
            <tr key={i} className="border-t border-outline-variant/10 bg-surface-container-lowest">
              <td className="px-4 py-3 font-mono text-primary">{c.parameter}</td>
              <td className="px-4 py-3 text-on-surface-variant">{c.currentValue}</td>
              <td className="px-4 py-3 font-semibold text-emerald-500">{c.newValue}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function VetoProposalModal({
  reason,
  reasonHash,
  submitting,
  onReasonChange,
  onSubmit,
  onClose,
}: {
  reason: string;
  reasonHash: string;
  submitting: boolean;
  onReasonChange: (reason: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-2xl border border-outline-variant/20 bg-surface-container-lowest shadow-2xl">
        <div className="border-b border-outline-variant/10 p-6">
          <h2 className="text-xl font-bold">Veto Proposal</h2>
          <p className="mt-1 text-sm text-on-surface-variant">
            This action is logged permanently on-chain.
          </p>
        </div>
        <div className="space-y-4 p-6">
          <label className="block text-sm font-semibold">
            Reason
            <textarea
              value={reason}
              onChange={(event) => onReasonChange(event.target.value)}
              className="mt-2 min-h-28 w-full rounded-xl border border-outline-variant/30 bg-surface-container-lowest p-3 text-sm outline-none focus:border-primary"
              placeholder="Explain why this proposal must be vetoed"
            />
          </label>
          {reasonHash && (
            <p className="break-all rounded-lg bg-surface-container p-3 font-mono text-xs text-on-surface-variant">
              reason_hash: {reasonHash}
            </p>
          )}
        </div>
        <div className="flex gap-3 p-6 pt-0">
          <button
            onClick={onClose}
            disabled={submitting}
            className="flex-1 rounded-xl border border-outline-variant/30 px-4 py-3 text-sm font-bold text-on-surface-variant disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={!reasonHash || submitting}
            className="flex-[2] rounded-xl bg-red-600 px-4 py-3 text-sm font-bold text-white disabled:opacity-50"
          >
            {submitting ? 'Submitting...' : 'Confirm Veto'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ProposalDetailPage() {
  const params = useParams();
  const router = useRouter();
  const { address, isConnected, connect } = useWallet();
  const { execute, loading: isVoting } = useTransaction();

  const proposalId = Number(params.id);

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [votingPower, setVotingPower] = useState<number>(0);
  const [isExecuting, setIsExecuting] = useState(false);
  const [vetoModalOpen, setVetoModalOpen] = useState(false);
  const [vetoReason, setVetoReason] = useState('');
  const [vetoReasonHash, setVetoReasonHash] = useState('');
  const [isVetoing, setIsVetoing] = useState(false);
  useDocumentTitle({ pageTitle: proposal?.title ?? `Proposal #${proposalId}` });

  const load = useCallback(async () => {
    const data = await fetchProposal(proposalId);
    if (!data) {
      router.replace('/governance');
      return;
    }
    setProposal(data);
    setLoading(false);
  }, [proposalId, router]);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30_000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (isConnected && address) {
      getVotingPower(address).then(setVotingPower);
    }
  }, [isConnected, address]);

  const handleVote = async (choice: VoteChoice) => {
    if (!proposal || !address) return;

    const result = await execute(async (signTx) => castVote(proposal.id, choice, address, signTx), {
      expectedAction: 'cast_vote',
      title: `Casting vote: ${choice}…`,
      pendingMessage: 'Waiting for wallet signature...',
      successTitle: 'Vote submitted',
      successMessage: `Your ${choice.toLowerCase()} vote has been recorded.`,
    });

    if (result) {
      await load();
    }
  };

  const handleExecute = async () => {
    if (!proposal || !address) return;

    setIsExecuting(true);
    const result = await execute(async (signTx) => executeProposal(proposal.id, address, signTx), {
      expectedAction: 'execute_proposal',
      title: 'Executing proposal…',
      pendingMessage: 'Waiting for wallet signature...',
      successTitle: 'Proposal executed',
      successMessage: 'The proposal has been successfully executed.',
    });

    if (result) {
      await load();
    }
    setIsExecuting(false);
  };

  const handleVetoReasonChange = async (reason: string) => {
    setVetoReason(reason);
    setVetoReasonHash(await hashEvidence(reason));
  };

  const handleVeto = async () => {
    if (!proposal || !address || !vetoReasonHash) return;

    setIsVetoing(true);
    // Routed through `execute` so the veto gets the same typed governance
    // handling as voting and execution: simulation errors surface before the
    // wallet prompt, and a confirmation timeout is reported as an unknown
    // outcome rather than a failure (#1044, #1045).
    const result = await execute(
      async (signTx) => vetoProposal(proposal.id, vetoReasonHash, address, signTx),
      {
        expectedAction: 'veto_proposal',
        title: 'Vetoing proposal…',
        pendingMessage: 'Waiting for wallet signature...',
        successTitle: 'Proposal vetoed',
        successMessage: 'The proposal has been vetoed on-chain.',
      }
    );

    if (result) {
      setVetoModalOpen(false);
      setVetoReason('');
      setVetoReasonHash('');
      // Status comes from the contract on reload rather than being set
      // locally, so the UI cannot show "Vetoed" for a transaction that never
      // settled.
      await load();
    }
    setIsVetoing(false);
  };

  // ─── Derived state ──────────────────────────────────────────────────────────

  const alreadyVoted = !!proposal?.userVote;
  const isActive = proposal?.status === 'Active';
  const isPassed = proposal?.status === 'Passed';
  const isAdmin = !!address && address === GOVERNANCE_ADMIN_ADDRESS;
  const canVote = isActive && !alreadyVoted && isConnected && votingPower > 0;

  const remaining = proposal ? timeRemaining(proposal) : '';
  const now = Math.floor(Date.now() / 1000);
  const timelockRemaining =
    proposal?.status === 'Passed' && proposal.executableAfter && proposal.executableAfter > now
      ? formatRelativeCountdown(proposal.executableAfter - now)
      : '';
  const executionSummary = proposal ? executionEffect(proposal) : null;

  // ─── Loading skeleton ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <main className="min-h-screen">
        <Navbar />
        <div className="pt-28 pb-20 px-8 max-w-7xl mx-auto animate-pulse space-y-6">
          <div className="h-6 w-24 bg-surface-container rounded-full" />
          <div className="h-10 w-2/3 bg-surface-container rounded-xl" />
          <div className="h-4 w-full bg-surface-container rounded" />
          <div className="h-4 w-3/4 bg-surface-container rounded" />
        </div>
      </main>
    );
  }

  if (!proposal) return null;

  return (
    <main className="min-h-screen">
      <Navbar />

      <div className="pt-28 pb-20 px-8">
        <div className="max-w-7xl mx-auto">
          {/* Breadcrumb */}
          <nav className="mb-8">
            <Link
              href="/governance"
              className="inline-flex items-center gap-1.5 text-sm text-on-surface-variant hover:text-primary transition-colors"
            >
              <span className="material-symbols-outlined text-[16px]">arrow_back</span>
              All Proposals
            </Link>
          </nav>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
            {/* ─── Left: Details ────────────────────────────────────────────── */}
            <div className="lg:col-span-2 space-y-6">
              {/* Header */}
              <div>
                <div className="flex flex-wrap items-center gap-2 mb-4">
                  <TypePill type={proposal.type} />
                  <StatusBadge status={proposal.status} />
                  <span className="text-sm text-on-surface-variant ml-auto">
                    Proposal #{proposal.id}
                  </span>
                </div>
                <h1 className="text-3xl md:text-4xl font-headline leading-tight mb-3">
                  {proposal.title}
                </h1>
                <p className="text-sm text-on-surface-variant">
                  Proposed by <span className="font-mono text-primary">{proposal.proposer}</span>
                </p>
              </div>

              {/* Description */}
              <div className="rounded-2xl border border-outline-variant/20 bg-surface-container-lowest p-6">
                <h2 className="text-lg font-semibold mb-3 flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[20px]">
                    description
                  </span>
                  Description
                </h2>
                <p className="text-on-surface-variant leading-relaxed">{proposal.description}</p>
              </div>

              {/* Parameter changes */}
              {proposal.parameterChanges && proposal.parameterChanges.length > 0 && (
                <div className="rounded-2xl border border-outline-variant/20 bg-surface-container-lowest p-6">
                  <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary text-[20px]">tune</span>
                    Parameter Changes
                  </h2>
                  <ParameterChangeTable changes={proposal.parameterChanges} />
                </div>
              )}

              {/* Timeline */}
              <div className="rounded-2xl border border-outline-variant/20 bg-surface-container-lowest p-6">
                <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                  <span className="material-symbols-outlined text-primary text-[20px]">
                    timeline
                  </span>
                  Timeline
                </h2>
                <ol className="relative border-l border-outline-variant/30 ml-2 space-y-5">
                  {[
                    {
                      label: 'Proposal submitted',
                      ts: proposal.createdAt,
                      done: true,
                      icon: 'edit',
                    },
                    {
                      label: 'Voting opened',
                      ts: proposal.votingStartsAt,
                      done: Date.now() / 1000 >= proposal.votingStartsAt,
                      icon: 'how_to_vote',
                    },
                    {
                      label: 'Voting closes',
                      ts: proposal.votingEndsAt,
                      done: Date.now() / 1000 >= proposal.votingEndsAt,
                      icon: 'lock_clock',
                    },
                    ...(proposal.executableAfter
                      ? [
                          {
                            label: 'Timelock expires — executable',
                            ts: proposal.executableAfter,
                            done: Date.now() / 1000 >= proposal.executableAfter,
                            icon: 'rocket_launch',
                          },
                        ]
                      : []),
                  ].map((step, i) => (
                    <li key={i} className="ml-5">
                      <span
                        className={`absolute -left-3 flex items-center justify-center w-6 h-6 rounded-full border ${
                          step.done
                            ? 'bg-primary border-primary text-white'
                            : 'bg-surface-container border-outline-variant text-on-surface-variant'
                        }`}
                      >
                        <span
                          className="material-symbols-outlined text-[13px]"
                          style={step.done ? { fontVariationSettings: "'FILL' 1" } : {}}
                        >
                          {step.icon}
                        </span>
                      </span>
                      <p
                        className={`text-sm font-medium ${
                          step.done ? 'text-on-surface' : 'text-on-surface-variant'
                        }`}
                      >
                        {step.label}
                      </p>
                      <p className="text-xs text-on-surface-variant">
                        {new Date(step.ts * 1000).toLocaleString()}
                      </p>
                    </li>
                  ))}
                </ol>
              </div>
            </div>

            {/* ─── Right: Voting panel ──────────────────────────────────────── */}
            <div className="space-y-5">
              <VoteSection
                proposal={proposal}
                isConnected={isConnected}
                alreadyVoted={alreadyVoted}
                userVote={proposal.userVote}
                onVote={handleVote}
                voteLoading={isVoting}
                canVote={canVote}
                connect={connect}
                votingPower={votingPower}
              />

              {/* Time remaining */}
              {isActive && remaining && (
                <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 px-5 py-4 flex items-center gap-3">
                  <span className="material-symbols-outlined text-amber-500">schedule</span>
                  <div>
                    <p className="text-sm font-semibold text-amber-500">Voting in progress</p>
                    <p className="text-xs text-on-surface-variant">{remaining}</p>
                  </div>
                </div>
              )}

              {isPassed && proposal?.executableAfter && (
                <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 space-y-3">
                  <div className="flex items-center gap-3 text-primary">
                    <span className="material-symbols-outlined text-[20px]">schedule</span>
                    <p className="text-sm font-semibold">Timelock status</p>
                  </div>

                  {timelockRemaining ? (
                    <div>
                      <p className="text-sm font-semibold">Timelock expires in</p>
                      <p className="text-xs text-on-surface-variant">{timelockRemaining}</p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <p className="text-sm font-semibold">Timelock expired</p>
                      <p className="text-xs text-on-surface-variant">
                        The execution delay has passed. Anyone can now execute this proposal
                        on-chain.
                      </p>
                      <GovernanceMockStatusBanner action="executeProposal" />
                      <button
                        onClick={handleExecute}
                        disabled={isExecuting}
                        className="w-full rounded-xl bg-primary py-3 text-sm font-bold text-white hover:bg-primary/90 active:scale-95 transition-all shadow-md disabled:opacity-50"
                      >
                        {isExecuting ? 'Executing…' : 'Execute Proposal'}
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Voting power */}
              {isConnected && <GovernanceMockStatusBanner action="getVotingPower" />}
              <div className="rounded-2xl border border-outline-variant/20 bg-surface-container-lowest p-5">
                <p className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-2">
                  Your Voting Power
                </p>
                {isConnected ? (
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold text-primary">
                      {formatVotingPower(votingPower)}
                    </span>
                    {votingPower === 0 && (
                      <span className="text-xs text-on-surface-variant">(no voting power)</span>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={connect}
                    className="w-full py-2.5 rounded-xl bg-primary text-white text-sm font-bold hover:bg-primary/90 active:scale-95 transition-all"
                  >
                    Connect wallet to vote
                  </button>
                )}
              </div>

              {/* Execute button (Passed proposals with no timelock information).
                  When `executableAfter` is known, the timelock panel above owns
                  the execute affordance so it stays gated on the delay and is
                  not rendered twice. */}
              {isPassed && !proposal?.executableAfter && (
                <div className="rounded-2xl border border-primary/30 bg-primary/5 p-5 space-y-3">
                  <div className="flex items-center gap-2 text-primary">
                    <span className="material-symbols-outlined text-[20px]">rocket_launch</span>
                    <p className="text-sm font-semibold">Proposal passed — ready to execute</p>
                  </div>
                  <p className="text-xs text-on-surface-variant">
                    The timelock delay has elapsed. Anyone can now trigger on-chain execution.
                  </p>
                  <GovernanceMockStatusBanner action="executeProposal" />
                  {isConnected ? (
                    <button
                      onClick={handleExecute}
                      disabled={isExecuting}
                      className="w-full py-3 rounded-xl bg-primary text-white text-sm font-bold hover:bg-primary/90 active:scale-95 transition-all shadow-md disabled:opacity-50"
                    >
                      {isExecuting ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="animate-spin material-symbols-outlined text-[16px]">
                            progress_activity
                          </span>
                          Executing…
                        </span>
                      ) : (
                        'Execute Proposal'
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={connect}
                      className="w-full py-3 rounded-xl bg-primary text-white text-sm font-bold hover:bg-primary/90 active:scale-95 transition-all"
                    >
                      Connect wallet to execute
                    </button>
                  )}
                </div>
              )}

              {/* Executed state */}
              {proposal.status === 'Executed' && (
                <div className="rounded-2xl border border-purple-500/30 bg-purple-500/5 px-5 py-4 space-y-3">
                  <div className="flex items-center gap-3 text-purple-500">
                    <span
                      className="material-symbols-outlined"
                      style={{ fontVariationSettings: "'FILL' 1" }}
                    >
                      verified
                    </span>
                    <p className="text-sm font-semibold">Already executed</p>
                  </div>
                  <p className="text-xs text-on-surface-variant">
                    Changes are live on the protocol.
                  </p>
                  {executionSummary && (
                    <div className="rounded-2xl border border-purple-500/10 bg-purple-500/10 p-3 text-sm text-purple-700">
                      {executionSummary}
                    </div>
                  )}
                </div>
              )}

              {isAdmin && proposal.status !== 'Executed' && proposal.status !== 'Vetoed' && (
                <div className="rounded-2xl border border-red-500/30 bg-red-500/5 p-5 space-y-3">
                  <div className="flex items-center gap-2 text-red-500">
                    <span className="material-symbols-outlined text-[20px]">gavel</span>
                    <p className="text-sm font-semibold">Admin veto controls</p>
                  </div>
                  <p className="text-xs text-on-surface-variant">
                    Only the configured governance admin address can veto proposals.
                  </p>
                  <GovernanceMockStatusBanner action="vetoProposal" />
                  <button
                    onClick={() => setVetoModalOpen(true)}
                    className="w-full rounded-xl bg-red-600 py-3 text-sm font-bold text-white transition-all hover:bg-red-700"
                  >
                    Veto Proposal
                  </button>
                </div>
              )}

              {proposal.vetoHistory && proposal.vetoHistory.length > 0 && (
                <div className="rounded-2xl border border-outline-variant/20 bg-surface-container-lowest p-5">
                  <h2 className="mb-3 text-base font-semibold">Veto History</h2>
                  <div className="space-y-3">
                    {proposal.vetoHistory.map((record) => (
                      <div
                        key={`${record.reasonHash}-${record.createdAt}`}
                        className="rounded-xl bg-surface-container p-3"
                      >
                        <p className="text-xs text-on-surface-variant">
                          {new Date(record.createdAt * 1000).toLocaleString()} by{' '}
                          <span className="font-mono">{record.admin}</span>
                        </p>
                        <p className="mt-1 break-all font-mono text-xs text-red-500">
                          {record.reasonHash}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {vetoModalOpen && (
        <VetoProposalModal
          reason={vetoReason}
          reasonHash={vetoReasonHash}
          submitting={isVetoing}
          onReasonChange={(reason) => void handleVetoReasonChange(reason)}
          onSubmit={() => void handleVeto()}
          onClose={() => !isVetoing && setVetoModalOpen(false)}
        />
      )}
    </main>
  );
}
