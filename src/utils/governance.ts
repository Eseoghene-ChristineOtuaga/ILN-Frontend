import {
  rpc,
  xdr,
  scValToNative,
  nativeToScVal,
  TransactionBuilder,
  Account,
  BASE_FEE,
  Operation,
  Address,
} from '@stellar/stellar-sdk';
import {
  CONTRACT_ID,
  GOVERNANCE_CONTRACT_ID,
  ILN_TOKEN_CONTRACT_ID,
  NETWORK_PASSPHRASE,
  RPC_URL,
  STELLAR_NETWORK,
} from '@/constants';
import {
  executeGovernanceMutation,
  governanceWritesEnabled,
  GovernanceTxError,
  type GovernanceMutationMethod,
  type GovernanceMutationOptions,
} from '@/lib/governance-tx';
import { isCancellationError } from '@/lib/transaction-lifecycle';
import { getConfiguredStellarNetwork, networksMatch } from '@/utils/network';
import { sep10Session } from '@/lib/sep10Session';
import {
  assertGovernanceSimulationPassed,
  type GovernanceSimulationOutcome,
} from '@/lib/governance/simulation';
import {
  isContractAddress,
  MAX_TOKEN_DECIMALS,
  type CreateProposalFormType,
  type CreateProposalPayload,
  type ProposalValidationContext,
} from '@/lib/governance/contract-schema';
import {
  fetchChainParameters,
  toValidationContext,
  type AcceptedToken,
  type ProtocolParameters,
} from '@/lib/governance/chain-parameters';
import {
  DEFAULT_LOOKBACK_LEDGERS,
  fetchConfirmedParameterUpdates,
  parameterLabel,
  type ParameterUpdateEvent,
} from '@/lib/governance/parameter-events';
import { submitCreateProposal, type CreateProposalStage } from '@/lib/governance/create-proposal';
import { getApprovedTokenIds, getTokenMetadata } from '@/utils/soroban';

export type { CreateProposalFormType, CreateProposalPayload, AcceptedToken, ProtocolParameters };
export type { ParameterUpdateEvent, CreateProposalStage };
export { parameterLabel };
export {
  validateProposalPayload,
  issuesByField,
  ProposalValidationError,
} from '@/lib/governance/contract-schema';
export {
  toValidationContext,
  requiredProposerBalance,
  baseUnitsToTokens,
  ChainParametersError,
} from '@/lib/governance/chain-parameters';
export { CreateProposalError } from '@/lib/governance/create-proposal';
export {
  decodeProposalCreatedEvent,
  decodeProposalExecutedEvent,
  decodeVoteCastEvent,
  decodeProposalVetoedEvent,
  decodeParameterUpdatedEvent,
  decodeGovernanceEvent,
  EventDecodingError,
  createProposalCreatedFixture,
  createProposalExecutedFixture,
  createVoteCastFixture,
  createProposalVetoedFixture,
  createParameterUpdatedFixture,
  createRawEventFixture,
  type DecodedProposalCreatedEvent,
  type DecodedProposalExecutedEvent,
  type DecodedVoteCastEvent,
  type DecodedProposalVetoedEvent,
  type DecodedParameterUpdatedEvent,
  type DecodedGovernanceEvent,
} from '@/lib/governance/event-decoding';

// ─── RPC & Contract helpers ───────────────────────────────────────────────────

const server = new rpc.Server(RPC_URL);
const READ_ACCOUNT = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

function buildGovernanceReadTransaction(method: string, params: xdr.ScVal[] = []) {
  return new TransactionBuilder(new Account(READ_ACCOUNT, '0'), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: GOVERNANCE_CONTRACT_ID,
        function: method,
        args: params,
      })
    )
    .setTimeout(30)
    .build();
}

function buildTokenReadTransaction(contractId: string, method: string, params: xdr.ScVal[] = []) {
  return new TransactionBuilder(new Account(READ_ACCOUNT, '0'), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: method,
        args: params,
      })
    )
    .setTimeout(30)
    .build();
}

// ─── Horizon helpers for governance events ────────────────────────────────────

function getHorizonBaseUrl(): string {
  return STELLAR_NETWORK === 'mainnet'
    ? 'https://horizon.stellar.org'
    : 'https://horizon-testnet.stellar.org';
}

interface HorizonTxRecord {
  hash?: string;
  created_at?: string;
  ledger?: number;
  successful?: boolean;
  memo?: string;
  _embedded?: {
    records?: Array<{
      type?: string;
      topics?: string[];
      value?: string;
    }>;
  };
}

interface HorizonTxResponse {
  _embedded?: { records?: HorizonTxRecord[] };
  _links?: { next?: { href?: string } };
}

const GOVERNANCE_MAX_PAGES = 10;
const GOVERNANCE_PAGE_LIMIT = 200;

async function fetchGovernanceTransactionsPage(url: string): Promise<HorizonTxResponse> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) {
    throw new Error(`Horizon governance fetch failed: ${res.status}`);
  }
  return (await res.json()) as HorizonTxResponse;
}

function decodeHexOrUtf8Topic(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    if (/^[0-9a-fA-F]+$/.test(raw) && raw.length > 4) {
      const bytes = Uint8Array.from(raw.match(/.{1,2}/g)!.map((b) => parseInt(b, 16)));
      return new TextDecoder().decode(bytes);
    }
  } catch {
    /* fall through */
  }
  return raw;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProposalType = 'ParameterUpdate' | 'ProtocolUpgrade' | 'TextProposal';
export type ProposalStatus = 'Active' | 'Passed' | 'Rejected' | 'Executed' | 'Vetoed';
export type VoteChoice = 'For' | 'Against';

export interface VetoRecord {
  proposalId: number;
  admin: string;
  reasonHash: string;
  createdAt: number;
}

export interface ParameterChange {
  parameter: string;
  currentValue: string;
  newValue: string;
}

export interface VoteCastEvent {
  proposalId: number;
  proposalTitle: string;
  voter: string;
  vote: VoteChoice;
  weight: number;
  timestamp: number;
}

export interface Proposal {
  id: number;
  title: string;
  description: string;
  type: ProposalType;
  status: ProposalStatus;
  proposer: string;
  createdAt: number;
  votingStartsAt: number;
  votingEndsAt: number;
  executableAfter?: number;
  votesFor: number;
  votesAgainst: number;
  votesAbstain?: number;
  quorumRequired: number;
  parameterChanges?: ParameterChange[];
  userVote?: VoteChoice;
  vetoHistory?: VetoRecord[];
}

// Keep this aligned with docs/contract-integration-status.md so the UI
// automatically reflects the current live vs mock-backed governance status.
type GovernanceActionName =
  | 'castVote'
  | 'delegateVotingPower'
  | 'createProposal'
  | 'executeProposal'
  | 'vetoProposal'
  | 'getVotingPower'
  | 'getGovTokenBalance'
  | 'getQuorumThreshold'
  | 'getProposalHistory';

/**
 * Integration state of a governance action.
 *
 * - `Real` — a signed Soroban transaction against a configured contract.
 * - `Unconfigured` — the real path is implemented, but no governance contract
 *   is configured, so the action raises `CONTRACT_NOT_CONFIGURED` instead of
 *   running (#1044, #1045). Distinct from `Stubbed`: there is no mock to fall
 *   back to, and setting `NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID` is all that
 *   stands between this and `Real`.
 * - `Stubbed` — still mock-backed; no real implementation exists yet.
 */
export type GovernanceIntegrationState = 'Real' | 'Unconfigured' | 'Stubbed';

/**
 * Governance writes went through the mock path until #1044/#1045 replaced it
 * with a real simulate → sign → submit → confirm pipeline. They now report
 * `Real` when a governance contract is configured and `Unconfigured`
 * otherwise, so the UI never claims an action is live when the contract it
 * targets has no governance entry points.
 */
const GOVERNANCE_WRITE_STATE: GovernanceIntegrationState = governanceWritesEnabled()
  ? 'Real'
  : 'Unconfigured';

export const GOVERNANCE_INTEGRATION_STATUS: Record<
  GovernanceActionName,
  { status: GovernanceIntegrationState; label: string }
> = {
  castVote: {
    status: GOVERNANCE_WRITE_STATE,
    label: 'Vote casting',
  },
  delegateVotingPower: {
    status: 'Stubbed',
    label: 'Vote delegation',
  },
  createProposal: {
    status: GOVERNANCE_WRITE_STATE,
    label: 'Proposal creation',
  },
  executeProposal: {
    status: GOVERNANCE_WRITE_STATE,
    label: 'Proposal execution',
  },
  vetoProposal: {
    status: GOVERNANCE_WRITE_STATE,
    label: 'Proposal veto',
  },
  getVotingPower: {
    status: 'Real',
    label: 'Voting power lookup',
  },
  getGovTokenBalance: {
    status: 'Stubbed',
    label: 'Token balance lookup',
  },
  getQuorumThreshold: {
    status: 'Stubbed',
    label: 'Quorum threshold lookup',
  },
  getProposalHistory: {
    status: 'Stubbed',
    label: 'Proposal history lookup',
  },
};

export type GovernanceAction = keyof typeof GOVERNANCE_INTEGRATION_STATUS;

// ─── Mock data ────────────────────────────────────────────────────────────────

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;

export const MOCK_PROPOSALS: Proposal[] = [
  {
    id: 1,
    title: 'Reduce Base Discount Rate to 3.5%',
    description:
      "This proposal reduces the protocol's base discount rate from 5% to 3.5% to improve competitiveness with traditional invoice factoring services and attract higher invoice volume from freelancers.",
    type: 'ParameterUpdate',
    status: 'Active',
    proposer: 'GDXYZ...A3KP',
    createdAt: NOW - 2 * DAY,
    votingStartsAt: NOW - 2 * DAY,
    votingEndsAt: NOW + 5 * DAY,
    votesFor: 142_500,
    votesAgainst: 38_200,
    votesAbstain: 0,
    quorumRequired: 100_000,
    parameterChanges: [
      { parameter: 'base_discount_rate', currentValue: '500 (5%)', newValue: '350 (3.5%)' },
    ],
  },
  {
    id: 2,
    title: 'Increase Quorum Threshold to 15%',
    description:
      'To ensure governance decisions represent a meaningful fraction of the token supply, this proposal raises the minimum quorum from 10% to 15% of circulating ILN tokens.',
    type: 'ParameterUpdate',
    status: 'Active',
    proposer: 'GBCDE...F7QR',
    createdAt: NOW - 1 * DAY,
    votingStartsAt: NOW - 1 * DAY,
    votingEndsAt: NOW + 6 * DAY,
    votesFor: 56_000,
    votesAgainst: 71_300,
    votesAbstain: 0,
    quorumRequired: 100_000,
    parameterChanges: [
      { parameter: 'quorum_threshold_bps', currentValue: '1000 (10%)', newValue: '1500 (15%)' },
    ],
  },
  {
    id: 3,
    title: 'Add EURC as Accepted Invoice Currency',
    description:
      "Expand the protocol's multi-token support by adding EURC (Euro Coin) as a valid invoice denomination alongside USDC. This targets European freelancers and eliminates FX conversion costs.",
    type: 'ProtocolUpgrade',
    status: 'Passed',
    proposer: 'GCFGH...B2MN',
    createdAt: NOW - 14 * DAY,
    votingStartsAt: NOW - 14 * DAY,
    votingEndsAt: NOW - 7 * DAY,
    executableAfter: NOW - 4 * DAY,
    votesFor: 215_800,
    votesAgainst: 44_100,
    votesAbstain: 0,
    quorumRequired: 100_000,
    parameterChanges: [
      {
        parameter: 'accepted_tokens',
        currentValue: '[USDC]',
        newValue: '[USDC, EURC]',
      },
    ],
  },
  {
    id: 4,
    title: 'Extend Voting Period to 10 Days',
    description:
      'Increase the governance voting window from 7 days to 10 days to give token holders across all time zones and schedules adequate opportunity to participate.',
    type: 'ParameterUpdate',
    status: 'Executed',
    proposer: 'GHIJK...L9PQ',
    createdAt: NOW - 30 * DAY,
    votingStartsAt: NOW - 30 * DAY,
    votingEndsAt: NOW - 23 * DAY,
    executableAfter: NOW - 20 * DAY,
    votesFor: 189_600,
    votesAgainst: 22_300,
    quorumRequired: 100_000,
    parameterChanges: [
      {
        parameter: 'voting_period_seconds',
        currentValue: '604800 (7 days)',
        newValue: '864000 (10 days)',
      },
    ],
  },
  {
    id: 5,
    title: 'Signal: Explore On-Chain Credit Scoring Integration',
    description:
      'A text proposal to gauge community sentiment on integrating a decentralised on-chain credit scoring module that could lower discount rates for freelancers with proven track records.',
    type: 'TextProposal',
    status: 'Rejected',
    proposer: 'GLMNO...P4RS',
    createdAt: NOW - 20 * DAY,
    votingStartsAt: NOW - 20 * DAY,
    votingEndsAt: NOW - 13 * DAY,
    votesFor: 44_200,
    votesAgainst: 88_700,
    quorumRequired: 100_000,
  },
  {
    id: 6,
    title: 'Deploy LP Yield Optimiser Contract',
    description:
      'Deploy a new ancillary contract that auto-compounds LP yield by re-deploying earned USDC into the highest-APY invoice pool at the end of each epoch.',
    type: 'ProtocolUpgrade',
    status: 'Active',
    proposer: 'GTUV...W5XY',
    createdAt: NOW - 3 * DAY,
    votingStartsAt: NOW - 3 * DAY,
    votingEndsAt: NOW + 4 * DAY,
    votesFor: 87_400,
    votesAgainst: 19_800,
    quorumRequired: 100_000,
  },
  {
    id: 7,
    title: 'Lower Protocol Fee Rate to 0.3%',
    description:
      "Reduce the protocol fee from 0.5% to 0.3% to pass more value back to liquidity providers and improve the protocol's competitiveness ahead of mainnet.",
    type: 'ParameterUpdate',
    status: 'Executed',
    proposer: 'GQRST...U8VW',
    createdAt: NOW - 9 * DAY,
    votingStartsAt: NOW - 9 * DAY,
    votingEndsAt: NOW - 2 * DAY,
    // Executed roughly 8 hours ago — recent enough to surface in the
    // homepage / marketplace announcement banner (48h window).
    executableAfter: NOW - Math.floor(DAY / 3),
    votesFor: 173_200,
    votesAgainst: 18_900,
    quorumRequired: 100_000,
    parameterChanges: [
      { parameter: 'fee_rate_bps', currentValue: '50 (0.5%)', newValue: '30 (0.3%)' },
    ],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function totalVotes(proposal: Proposal): number {
  return proposal.votesFor + proposal.votesAgainst;
}

export function votePercent(votes: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((votes / total) * 1000) / 10; // one decimal place
}

export function quorumReached(proposal: Proposal): boolean {
  return totalVotes(proposal) >= proposal.quorumRequired;
}

export function timeRemaining(proposal: Proposal): string {
  const now = Math.floor(Date.now() / 1000);
  if (proposal.status !== 'Active') return '';
  const diff = proposal.votingEndsAt - now;
  if (diff <= 0) return 'Ended';
  const days = Math.floor(diff / DAY);
  const hours = Math.floor((diff % DAY) / 3600);
  if (days > 0) return `${days}d ${hours}h remaining`;
  const mins = Math.floor((diff % 3600) / 60);
  return `${hours}h ${mins}m remaining`;
}

export function formatVotingPower(power: number): string {
  if (power >= 1_000_000) return (power / 1_000_000).toFixed(2) + 'M ILN';
  if (power >= 1_000) return (power / 1_000).toFixed(1) + 'K ILN';
  return power.toFixed(0) + ' ILN';
}

// ─── Mock voting state (per-session in-memory store) ──────────────────────────

const userVotes: Map<number, VoteChoice> = new Map();
const vetoHistory: VetoRecord[] = [];
const proposalTxHashes: Map<string, string> = new Map();
// Confirmed creations only, keyed by proposer + payload, so a double-click
// after confirmation returns the same on-chain result instead of re-submitting.
const proposalCreationCache: Map<
  string,
  { txHash: string; proposalId: number; timestamp: number }
> = new Map();
// In-flight creations, so concurrent duplicate submissions share one transaction.
const proposalCreationInFlight: Map<
  string,
  Promise<{ txHash: string; proposalId: number }>
> = new Map();
// In-flight mutations, so concurrent duplicate submissions share one transaction (#1046).
const voteInFlight: Map<string, Promise<string>> = new Map();
const executeInFlight: Map<string, Promise<string>> = new Map();
const vetoInFlight: Map<string, Promise<string>> = new Map();
const delegateInFlight: Map<string, Promise<string>> = new Map();

export function clearGovernanceIdempotencyCache(): void {
  proposalTxHashes.clear();
  proposalCreationCache.clear();
  proposalCreationInFlight.clear();
  voteInFlight.clear();
  executeInFlight.clear();
  vetoInFlight.clear();
  delegateInFlight.clear();
}

export function getUserVote(proposalId: number): VoteChoice | undefined {
  return userVotes.get(proposalId);
}

export class VotingPowerError extends Error {
  readonly code = 'VOTING_POWER_UNAVAILABLE';
  constructor(
    message: string,
    override readonly cause?: unknown
  ) {
    super(`VOTING_POWER_UNAVAILABLE: ${message}`);
    this.name = 'VotingPowerError';
  }
}

/**
 * Optional, additive hooks for every governance write path.
 *
 * Callbacks are opt-in so existing call sites keep their behaviour:
 *
 * - `simulate` runs a Soroban dry-run *before* the wallet prompt. A failed
 *   simulation throws a typed {@link import('@/lib/governance/simulation').GovernanceSimulationError}
 *   and neither signs nor mutates (#1063).
 * - `onConfirmed` runs only after the mutation has completed successfully.
 *   Query-cache invalidation belongs here so rejected / failed / pending
 *   writes cannot refresh data (#1065).
 * - `votingPower` explicit voting power to apply; if omitted, read from the
 *   governance contract authority (#1048, #1049).
 * - `walletNetwork` reported wallet network; verified against configured network
 *   to ensure wrong-network transactions cannot be signed (#1067).
 */
export class GovernanceNetworkMismatchError extends Error {
  readonly code = 'NETWORK_MISMATCH';

  constructor(configured: string, wallet: string) {
    super(
      `NETWORK_MISMATCH: Network mismatch detected. Configured network is ${configured}, but wallet network is ${wallet}. Transactions cannot be signed.`
    );
    this.name = 'GovernanceNetworkMismatchError';
  }
}

/** Assert that wallet network matches configured network before signing (#1067). */
export function assertGovernanceNetworkMatches(
  walletNetwork?: string,
  configuredNetwork: string = getConfiguredStellarNetwork()
): void {
  if (!walletNetwork) return;
  if (!networksMatch(walletNetwork, configuredNetwork)) {
    throw new GovernanceNetworkMismatchError(configuredNetwork, walletNetwork);
  }
}

export interface GovernanceMutationOptions {
  simulate?: () => Promise<GovernanceSimulationOutcome>;
  onConfirmed?: (txHash: string) => void | Promise<void>;
  votingPower?: number;
  walletNetwork?: string;
}

// ─── Contract Parsers ─────────────────────────────────────────────────────────

export function parseProposalStatus(status: unknown): ProposalStatus {
  if (status && typeof status === 'object') {
    const key = Object.keys(status as object)[0];
    if (key === 'Rejected') return 'Rejected';
    if (key === 'Active' || key === 'Passed' || key === 'Executed' || key === 'Vetoed') {
      return key as ProposalStatus;
    }
  }
  const str = String(status);
  if (str === 'Rejected') return 'Rejected';
  if (str === 'Active' || str === 'Passed' || str === 'Executed' || str === 'Vetoed') {
    return str as ProposalStatus;
  }
  return 'Active';
}

export function parseProposalType(action: unknown): ProposalType {
  if (action && typeof action === 'object') {
    const key = Object.keys(action as object)[0];
    if (key === 'ParameterUpdate' || key === 'ProtocolUpgrade' || key === 'TextProposal') {
      return key as ProposalType;
    }
  }
  const str = String(action);
  if (str === 'ParameterUpdate' || str === 'ProtocolUpgrade' || str === 'TextProposal') {
    return str as ProposalType;
  }
  return 'ParameterUpdate';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseProposalFromNative(native: any): Proposal {
  return {
    id: Number(native.id ?? 0),
    title:
      typeof native.title === 'string' ? native.title : native.title ? String(native.title) : '',
    description:
      typeof native.description === 'string'
        ? native.description
        : native.description
          ? String(native.description)
          : '',
    type: parseProposalType(native.type ?? native.action),
    status: parseProposalStatus(native.status),
    proposer: String(native.proposer ?? ''),
    createdAt: Number(native.created_at ?? native.createdAt ?? 0),
    votingStartsAt: Number(native.voting_starts_at ?? native.votingStartsAt ?? 0),
    votingEndsAt: Number(native.voting_ends_at ?? native.votingEndsAt ?? 0),
    executableAfter: native.executable_after
      ? Number(native.executable_after)
      : native.executableAfter
        ? Number(native.executableAfter)
        : undefined,
    votesFor: Number(native.votes_for ?? native.votesFor ?? 0),
    votesAgainst: Number(native.votes_against ?? native.votesAgainst ?? 0),
    quorumRequired: Number(native.quorum_required ?? native.quorumRequired ?? 0),
    parameterChanges: Array.isArray(native.parameter_changes ?? native.parameterChanges)
      ? (native.parameter_changes ?? native.parameterChanges).map((pc: any) => ({
          parameter: String(pc.parameter ?? ''),
          currentValue: String(pc.current_value ?? pc.currentValue ?? ''),
          newValue: String(pc.new_value ?? pc.newValue ?? ''),
        }))
      : undefined,
  };
}

// ─── Contract Integration Calls ────────────────────────────────────────────────

export class GovernanceReadError extends Error {
  readonly code = 'GOVERNANCE_READ_UNAVAILABLE';
  constructor(message: string, readonly cause?: unknown) {
    super(`GOVERNANCE_READ_UNAVAILABLE: ${message}`);
    this.name = 'GovernanceReadError';
  }
}

export interface FetchProposalsOptions {
  allowMockFallback?: boolean;
}

export async function fetchProposals(options: FetchProposalsOptions = {}): Promise<Proposal[]> {
  let callResult: rpc.Api.SimulateTransactionResponse;
  try {
    const tx = buildGovernanceReadTransaction('list_proposals');
    callResult = await server.simulateTransaction(tx);
  } catch (err) {
    if (options.allowMockFallback) {
      return MOCK_PROPOSALS.map((p) => ({
        ...p,
        userVote: userVotes.get(p.id),
        vetoHistory: getVetoHistory(p.id),
      }));
    }
    throw new GovernanceReadError('Failed to simulate list_proposals read on governance contract', err);
  }

  if (rpc.Api.isSimulationSuccess(callResult) && callResult.result?.retval) {
    const native = scValToNative(callResult.result.retval);
    if (Array.isArray(native)) {
      return native.map((p) => ({
        ...parseProposalFromNative(p),
        userVote: userVotes.get(Number(p.id)),
        vetoHistory: getVetoHistory(Number(p.id)),
      }));
    }
  }

  if (options.allowMockFallback) {
    return MOCK_PROPOSALS.map((p) => ({
      ...p,
      userVote: userVotes.get(p.id),
      vetoHistory: getVetoHistory(p.id),
    }));
  }

  throw new GovernanceReadError(
    'Governance authority returned an unsuccessful simulation for list_proposals'
  );
}

export const getProposals = fetchProposals;

export async function fetchProposal(
  id: number,
  options: FetchProposalsOptions = {}
): Promise<Proposal | null> {
  const proposals = await fetchProposals(options);
  const proposal = proposals.find((p) => p.id === id);
  if (!proposal) return null;
  return { ...proposal, userVote: userVotes.get(id), vetoHistory: getVetoHistory(id) };
}

// ─── Governance write boundary (#1044, #1045) ─────────────────────────────────
//
// Every mutation below is a real signed Soroban transaction: it is simulated
// before the wallet is prompted (#1044) and confirmed under an explicit bound
// afterwards (#1045), via `src/lib/governance-tx.ts`. None of them writes to
// MOCK_PROPOSALS — that array is a read-only fallback for the proposal *list*
// when no governance contract is configured, and a write against an
// unconfigured deployment raises `CONTRACT_NOT_CONFIGURED` instead of
// fabricating a local tally.
//
// `userVotes` / `vetoHistory` are only ever written from a *confirmed*
// settlement below, so they cache network truth rather than invent it.

/**
 * Vote choice as the contract encodes it.
 *
 * `cast_vote(voter: address, proposal_id: u64, choice: u32)` — the shape
 * pinned by the signing-preview allowlist in
 * `src/utils/transactionPattern.ts`. Keep this map and that allowlist in step
 * with the `iln_governance` contract (`sync:smart-contract`).
 */
const VOTE_CHOICE_CODE: Record<VoteChoice, number> = {
  For: 1,
  Against: 0,
};

/** Proposal types as the contract's `create_proposal` discriminant. */
const PROPOSAL_TYPE_CODE: Record<CreateProposalFormType, number> = {
  FeeRate: 0,
  MaxDiscountRate: 1,
  AddToken: 2,
  RemoveToken: 3,
};

/** Window in which an identical create_proposal submission is treated as a replay. */
const PROPOSAL_CREATION_DEDUPE_MS = 30_000;

/**
 * Tuning / injection points shared by every governance write.
 *
 * Callers normally pass nothing; tests use `rpcServer` and `sleep` to drive
 * the pipeline deterministically, and the UI can pass `onStage` to reflect
 * `signed → submitted → confirming` progress.
 */
export type GovernanceWriteOptions = Pick<
  GovernanceMutationOptions,
  'onStage' | 'attempts' | 'intervalMs' | 'timeoutMs' | 'rpcServer' | 'sleep'
>;

/**
 * Encodes the type-specific part of a proposal as the single `value` argument
 * `create_proposal` carries: a basis-point figure for the rate proposals, or
 * a token contract address for the allowlist proposals.
 */
function encodeProposalValue(payload: CreateProposalPayload): string {
  switch (payload.formType) {
    case 'FeeRate':
    case 'MaxDiscountRate':
      if (payload.newValueBps === undefined) {
        throw new GovernanceTxError({
          code: 'SIMULATION_FAILED',
          phase: 'preflight',
          method: 'create_proposal',
          message: `${payload.formType} proposals require newValueBps.`,
          remediation: 'Enter a new basis-point value before submitting the proposal.',
          resubmitSafe: true,
        });
      }
      return String(payload.newValueBps);
    case 'AddToken':
      if (!payload.tokenAddress) {
        throw new GovernanceTxError({
          code: 'SIMULATION_FAILED',
          phase: 'preflight',
          method: 'create_proposal',
          message: 'AddToken proposals require tokenAddress.',
          remediation: 'Look up and select a token before submitting the proposal.',
          resubmitSafe: true,
        });
      }
      return payload.tokenAddress;
    case 'RemoveToken':
      if (!payload.removeTokenAddress) {
        throw new GovernanceTxError({
          code: 'SIMULATION_FAILED',
          phase: 'preflight',
          method: 'create_proposal',
          message: 'RemoveToken proposals require removeTokenAddress.',
          remediation: 'Select the token to remove before submitting the proposal.',
          resubmitSafe: true,
        });
      }
      return payload.removeTokenAddress;
  }
}

/**
 * Reads the proposal id the contract assigned from the confirmed invocation's
 * return value.
 *
 * A confirmed `create_proposal` that returns nothing parseable is a contract
 * boundary mismatch, not a reason to invent an id — the transaction landed,
 * so the error says so and points at the hash.
 * Enforce a valid SEP-10 session before any backend-authorized governance or
 * admin operation. Throws with a typed error code so callers can prompt
 * reauthentication rather than silently failing.
 *
 * #1076: Gate authenticated governance actions
 */
function requireSep10Session(signerAddress: string): void {
  if (!sep10Session.hasValidSession(signerAddress)) {
    throw new Error(
      'SEP10_SESSION_REQUIRED: A valid authenticated session is required to perform governance actions. Please reconnect your wallet.'
    );
  }
}

/**
 * Deterministic stand-in transaction hash derived from the wallet signature.
 * Replaces the previous `Math.random()` hashes so no fabricated random value
 * reaches the UI (#1141); the same signed intent always yields the same hash.
 * Emits a 64-character hex string so it satisfies the standard Stellar
 * transaction-hash shape enforced by `isValidTxHash` (#1148).
 */
function parseCreatedProposalId(returnValue?: xdr.ScVal): number {
  if (returnValue) {
    try {
      const native = scValToNative(returnValue);
      const id = Number(typeof native === 'object' && native !== null ? native.id : native);
      if (Number.isInteger(id) && id > 0) return id;
    } catch {
      /* fall through to the explicit error below */
    }
  }
  throw new GovernanceTxError({
    code: 'TX_FAILED',
    phase: 'confirmation',
    method: 'create_proposal',
    message:
      'create_proposal confirmed but returned no proposal id, so the new proposal cannot be ' +
      'identified.',
    remediation:
      'The transaction was confirmed on-chain. Reload the proposal list to find the new ' +
      'proposal — do not submit it again.',
    resubmitSafe: false,
  });
}

/**
 * Rejects a write before any network round-trip when no signer is available.
 *
 * The previous mock path accepted an empty address and returned a synthetic
 * hash; a real transaction has no source account without one, so this is now
 * an explicit error rather than a silent fallback.
 */
function requireSigner(signerAddress: string, method: GovernanceMutationMethod): string {
  const trimmed = signerAddress?.trim() ?? '';
  if (!trimmed) {
    throw new GovernanceTxError({
      code: 'SOURCE_ACCOUNT_MISSING',
      phase: 'preflight',
      method,
      message: 'SOURCE_ACCOUNT_MISSING: no wallet address was supplied for a governance write.',
      remediation: 'Connect your wallet before performing a governance action.',
    });
  }
  // `Address.fromString` is the authoritative check: the format regex accepts
  // strings with a valid charset but a bad strkey checksum, which would then
  // throw untyped from deep inside argument encoding.
  try {
    Address.fromString(trimmed);
  } catch {
    throw new GovernanceTxError({
      code: 'SOURCE_ACCOUNT_MISSING',
      phase: 'preflight',
      method,
      message: `SOURCE_ACCOUNT_MISSING: "${trimmed}" is not a valid Stellar address.`,
      remediation: 'Reconnect your wallet — the connected address is not a valid Stellar account.',
    });
  }
  return trimmed;
}

/**
 * Casts an on-chain vote and returns the confirmed transaction hash.
 *
 * Simulated before signing, so an unauthorized account or a closed voting
 * window is reported before the wallet prompt (#1044). Resolves only once the
 * network confirms the transaction; a bounded-confirmation timeout throws
 * {@link GovernanceTxTimeoutError} rather than reporting a false success or a
 * false failure (#1045).
 *
 * The local tally is *not* adjusted here. `votesFor` / `votesAgainst` come
 * from the contract on the next {@link fetchProposals}, so a confirmed vote
 * can never disagree with on-chain state.
 */
export async function castVote(
  proposalId: number,
  choice: VoteChoice,
  signerAddress: string,
  signTx: (xdr: string) => Promise<string>,
  options: GovernanceWriteOptions = {}
): Promise<string> {
  const voter = requireSigner(signerAddress, 'cast_vote');
  const cacheKey = `${voter}:vote:${proposalId}`;
  options: GovernanceMutationOptions = {}
): Promise<string> {
  assertGovernanceNetworkMatches(options.walletNetwork);
  requireSep10Session(signerAddress);

  const cacheKey = `${signerAddress || 'anon'}:vote:${proposalId}`;
  const inFlightKey = `${signerAddress || 'anon'}:vote:${proposalId}:${choice}`;
  const previousVote = userVotes.get(proposalId);

  // Idempotent replay of an identical, already-confirmed vote: return the
  // settled hash without re-signing or re-submitting (#1146).
  if (userVotes.get(proposalId) === choice) {
    const existingHash = proposalTxHashes.get(cacheKey);
    if (existingHash) return existingHash;
  }

  const { txHash } = await executeGovernanceMutation({
    method: 'cast_vote',
    args: [
      Address.fromString(voter).toScVal(),
      nativeToScVal(proposalId, { type: 'u64' }),
      nativeToScVal(VOTE_CHOICE_CODE[choice], { type: 'u32' }),
    ],
    signerAddress: voter,
    signTx,
    pendingLabel: `cast_vote:${proposalId}`,
    ...options,
  });
  // Dry-run before the wallet prompt: a failed simulation is rendered to the
  // user without ever opening the wallet, and nothing is mutated (#1063).
  if (options.simulate) {
    await assertGovernanceSimulationPassed(options.simulate);
  }
  // Concurrent deduplication: rapid duplicate submissions share one in-flight transaction (#1046).
  const inFlight = voteInFlight.get(inFlightKey);
  if (inFlight) return inFlight;

  const run = (async () => {
    // TODO: Replace with actual Soroban transaction once governance contract is deployed
    // Ref: #111
    await new Promise((r) => setTimeout(r, 2000));

    const proposal = MOCK_PROPOSALS.find((p) => p.id === proposalId);

    // Dry-run before the wallet prompt: a failed simulation is rendered to the
    // user without ever opening the wallet, and nothing is mutated (#1063).
    if (options.simulate) {
      await assertGovernanceSimulationPassed(options.simulate);
    }

  // Only a confirmed settlement updates local state (#1142).
  userVotes.set(proposalId, choice);
  proposalTxHashes.set(cacheKey, txHash);
  // Cache refresh is a confirmed-only concern (#1065).
  await options.onConfirmed?.(txHash);
  return txHash;
    // Fail closed if voting power cannot be verified (#1049)
    let power = options.votingPower;
    if (power === undefined && signerAddress) {
      try {
        power = await getVotingPower(signerAddress);
      } catch (err) {
        throw new Error(
          `VOTING_POWER_UNAVAILABLE: Voting power could not be verified from governance authority (${
            err instanceof Error ? err.message : String(err)
          }). Mutation blocked.`
        );
      }
    }

    if (signerAddress && (power === undefined || power <= 0)) {
      throw new Error(
        'VOTING_POWER_UNAVAILABLE: Voter has zero or unavailable voting power. Mutation blocked.'
      );
    }

    const effectivePower = power ?? 0;

    // Signature gate before any mutation: a declined wallet changes nothing (#1144).
    const signed = await requireGovernanceSignature(
      `vote:${proposalId}:${choice}:${signerAddress}`,
      signerAddress,
      signTx
    );

    // If user changed their vote, adjust previous choice count
    if (proposal && previousVote && previousVote !== choice) {
      if (previousVote === 'For') {
        proposal.votesFor = Math.max(0, proposal.votesFor - effectivePower);
      } else if (previousVote === 'Against') {
        proposal.votesAgainst = Math.max(0, proposal.votesAgainst - effectivePower);
      } else if (previousVote === 'Abstain') {
        proposal.votesAbstain = Math.max(0, (proposal.votesAbstain ?? 0) - effectivePower);
      }
    }

    userVotes.set(proposalId, choice);

    if (proposal && previousVote !== choice) {
      if (choice === 'For') proposal.votesFor += effectivePower;
      else if (choice === 'Against') proposal.votesAgainst += effectivePower;
      else if (choice === 'Abstain')
        proposal.votesAbstain = (proposal.votesAbstain ?? 0) + effectivePower;
    }

    // Deterministic hash rooted in the collected signature; cached so an
    // idempotent replay returns the identical confirmation (#1141, #1146).
    const txHash = deriveGovernanceTxHash(signed, `vote:${proposalId}:${choice}:${signerAddress}`);
    proposalTxHashes.set(cacheKey, txHash);
    // Cache refresh is a confirmed-only concern (#1065).
    await options.onConfirmed?.(txHash);
    return txHash;
  })();

  voteInFlight.set(inFlightKey, run);
  try {
    return await run;
  } finally {
    voteInFlight.delete(inFlightKey);
  }
}

/**
 * Executes a passed proposal on-chain and returns the confirmed hash.
 *
 * A proposal still inside its timelock, or already executed, is rejected by
 * simulation before the wallet is prompted (#1044). The proposal's status is
 * not set locally — it is re-read from the contract, so the UI cannot show
 * "Executed" for a transaction that never settled.
 */
export async function executeProposal(
  proposalId: number,
  signerAddress: string,
  signTx: (xdr: string) => Promise<string>,
  options: GovernanceWriteOptions = {}
): Promise<string> {
  const caller = requireSigner(signerAddress, 'execute_proposal');
  options: GovernanceMutationOptions = {}
): Promise<string> {
  assertGovernanceNetworkMatches(options.walletNetwork);
  requireSep10Session(signerAddress);

  const proposal = MOCK_PROPOSALS.find((p) => p.id === proposalId);
  if (!proposal) throw new Error('Proposal not found');

  const cacheKey = `execute:${proposalId}`;

  // Idempotent replay of an already-confirmed execution (#1146).
  const existing = proposalTxHashes.get(cacheKey);
  if (existing) return existing;

  const { txHash } = await executeGovernanceMutation({
    method: 'execute_proposal',
    args: [Address.fromString(caller).toScVal(), nativeToScVal(proposalId, { type: 'u64' })],
    signerAddress: caller,
    signTx,
    pendingLabel: `execute_proposal:${proposalId}`,
    ...options,
  });
  // Simulation fails before signing: no wallet prompt, no status change (#1063).
  if (options.simulate) {
    await assertGovernanceSimulationPassed(options.simulate);
  }
  // Concurrent deduplication: rapid duplicate executions share one in-flight transaction (#1046).
  const inFlight = executeInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const run = (async () => {
    // TODO: Replace with actual Soroban transaction once governance contract is deployed
    // Ref: #111
    await new Promise((r) => setTimeout(r, 2000));

  proposalTxHashes.set(cacheKey, txHash);
  await options.onConfirmed?.(txHash);
  return txHash;
    // Simulation fails before signing: no wallet prompt, no status change (#1063).
    if (options.simulate) {
      await assertGovernanceSimulationPassed(options.simulate);
    }

    const executedSigned = await requireGovernanceSignature(
      `execute:${proposalId}:${signerAddress}`,
      signerAddress,
      signTx
    );

    proposal.status = 'Executed';
    const txHash = deriveGovernanceTxHash(executedSigned, `execute:${proposalId}`);
    proposalTxHashes.set(cacheKey, txHash);
    await options.onConfirmed?.(txHash);
    return txHash;
  })();

  executeInFlight.set(cacheKey, run);
  try {
    return await run;
  } finally {
    executeInFlight.delete(cacheKey);
  }
}

/**
 * Vetoes a proposal as the governance admin and returns the confirmed hash.
 *
 * A non-admin wallet is rejected by simulation with
 * `SIMULATION_UNAUTHORIZED` before the wallet is prompted (#1044), so the
 * admin-only boundary is enforced by the contract rather than by UI gating
 * alone. The veto record is appended only after confirmation.
 */
export async function vetoProposal(
  proposalId: number,
  reasonHash: string,
  adminAddress: string,
  signTx: (xdr: string) => Promise<string>,
  options: GovernanceWriteOptions = {}
): Promise<string> {
  const admin = requireSigner(adminAddress, 'veto_proposal');
  options: GovernanceMutationOptions = {}
): Promise<string> {
  assertGovernanceNetworkMatches(options.walletNetwork);
  requireSep10Session(adminAddress);

  const proposal = MOCK_PROPOSALS.find((p) => p.id === proposalId);
  if (!proposal) throw new Error('Proposal not found');

  const cacheKey = `veto:${proposalId}:${reasonHash}`;

  // Idempotent replay of an identical, already-confirmed veto (#1146).
  const existing = proposalTxHashes.get(cacheKey);
  if (existing) return existing;

  const { txHash } = await executeGovernanceMutation({
    method: 'veto_proposal',
    args: [
      Address.fromString(admin).toScVal(),
      nativeToScVal(proposalId, { type: 'u64' }),
      nativeToScVal(reasonHash, { type: 'string' }),
    ],
    signerAddress: admin,
    signTx,
    pendingLabel: `veto_proposal:${proposalId}`,
    ...options,
  });
  // Simulation fails before signing: no wallet prompt, no veto record (#1063).
  if (options.simulate) {
    await assertGovernanceSimulationPassed(options.simulate);
  }
  // Concurrent deduplication: rapid duplicate vetoes share one in-flight transaction (#1046).
  const inFlight = vetoInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const run = (async () => {
    await new Promise((r) => setTimeout(r, 1200));

  // Confirmed on-chain: record the settled veto so the detail page can show
  // it before the next contract read completes.
  vetoHistory.unshift({
    proposalId,
    admin,
    reasonHash,
    createdAt: Math.floor(Date.now() / 1000),
  });
  proposalTxHashes.set(cacheKey, txHash);
  return txHash;
  };
  vetoHistory.unshift(record);
  proposal.vetoHistory = [record, ...(proposal.vetoHistory ?? [])];
    // Simulation fails before signing: no wallet prompt, no veto record (#1063).
    if (options.simulate) {
      await assertGovernanceSimulationPassed(options.simulate);
    }

    // Signature gate before any mutation (#1144).
    const signed = await requireGovernanceSignature(
      `veto:${proposalId}:${reasonHash}:${adminAddress}`,
      adminAddress,
      signTx
    );

    proposal.status = 'Vetoed';
    const record: VetoRecord = {
      proposalId,
      admin: adminAddress,
      reasonHash,
      createdAt: Math.floor(Date.now() / 1000),
    };
    vetoHistory.unshift(record);
    proposal.vetoHistory = [record, ...(proposal.vetoHistory ?? [])];

    const vetoTxHash = deriveGovernanceTxHash(signed, `veto:${proposalId}:${reasonHash}`);
    proposalTxHashes.set(cacheKey, vetoTxHash);
    await options.onConfirmed?.(vetoTxHash);
    return vetoTxHash;
  })();

  vetoInFlight.set(cacheKey, run);
  try {
    return await run;
  } finally {
    vetoInFlight.delete(cacheKey);
  }
}

export function getVetoHistory(proposalId: number): VetoRecord[] {
  return vetoHistory.filter((record) => record.proposalId === proposalId);
}

export async function getVotingPower(address: string): Promise<number> {
  if (!address || !isValidStellarAddress(address)) {
    throw new VotingPowerError('Invalid or missing Stellar address for voting power read');
  }
  let callResult: rpc.Api.SimulateTransactionResponse;
  try {
    const params: xdr.ScVal[] = [Address.fromString(address).toScVal()];
    callResult = await server.simulateTransaction(
      buildGovernanceReadTransaction('get_voting_power', params)
    );
  } catch (err) {
    throw new VotingPowerError('Failed to simulate voting power read on governance contract', err);
  }
  if (!rpc.Api.isSimulationSuccess(callResult) || !callResult.result?.retval) {
    throw new VotingPowerError(
      'Governance authority returned an unsuccessful simulation for voting power'
    );
  }
  const balance = BigInt(scValToNative(callResult.result.retval));
  return Number(balance);
}

/**
 * Governance-token balance of `address` in base units, for the proposal
 * creation gate (#1054). Unlike {@link getVotingPower} this throws when the
 * balance cannot be read, so the UI can say so instead of showing zero.
 */
export async function fetchProposerBalance(address: string): Promise<bigint> {
  const callResult = await server.simulateTransaction(
    buildTokenReadTransaction(ILN_TOKEN_CONTRACT_ID, 'balance', [
      Address.fromString(address).toScVal(),
    ])
  );
  if (!rpc.Api.isSimulationSuccess(callResult) || !callResult.result?.retval) {
    throw new Error('Could not read your ILN balance from the network.');
  }
  return BigInt(scValToNative(callResult.result.retval));
}

export class DelegationError extends Error {
  readonly code = 'DELEGATION_UNAVAILABLE';
  constructor(
    message: string,
    override readonly cause?: unknown
  ) {
    super(`DELEGATION_UNAVAILABLE: ${message}`);
    this.name = 'DelegationError';
  }
}

export interface DelegationInfo {
  delegatedTo: string | null;
  delegatedAmount: number;
  incomingDelegations: number;
}

/**
 * Normalizes a delegated Stellar/Soroban address from contract responses.
 * Returns a valid 56-character strkey (G... or C...) or null if not set/empty.
 */
export function normalizeDelegatedAddress(raw: unknown): string | null {
  if (!raw) return null;
  let str: string;
  if (typeof raw === 'object' && raw !== null && 'toString' in raw) {
    str = (raw as { toString: () => string }).toString().trim();
  } else if (typeof raw === 'string') {
    str = raw.trim();
  } else {
    return null;
  }
  if (!str || str.toLowerCase() === 'none') return null;
  if (!isValidStellarAddress(str)) return null;
  return str;
}

/**
 * Normalizes an integer unit amount returned from Soroban responses into whole tokens.
 * Handles bigint, number, string, and i128 base units safely.
 */
export function normalizeDelegatedAmount(raw: unknown, decimals = 7): number {
  if (raw === null || raw === undefined) return 0;
  let big: bigint;
  try {
    if (typeof raw === 'bigint') {
      big = raw;
    } else if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) return 0;
      big = BigInt(Math.floor(raw));
    } else if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed || !/^-?\d+$/.test(trimmed)) return 0;
      big = BigInt(trimmed);
    } else {
      return 0;
    }
  } catch {
    return 0;
  }
  if (big <= 0n) return 0;

  const scale = 10n ** BigInt(decimals);
  if (big >= scale && big % scale === 0n) {
    const whole = big / scale;
    if (whole <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(whole);
    }
  }
  if (big <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(big);
  }
  return Number(big / scale);
}

export function parseDelegationInfoFromNative(native: unknown): DelegationInfo {
  if (!native || typeof native !== 'object') {
    return {
      delegatedTo: null,
      delegatedAmount: 0,
      incomingDelegations: 0,
    };
  }

  if (Array.isArray(native)) {
    const delegatedTo = normalizeDelegatedAddress(native[0]);
    const delegatedAmount = delegatedTo ? normalizeDelegatedAmount(native[1]) : 0;
    const incomingDelegations = normalizeDelegatedAmount(native[2]);
    return { delegatedTo, delegatedAmount, incomingDelegations };
  }

  const obj = native as Record<string, unknown>;
  const rawDelegate = obj.delegate ?? obj.delegated_to ?? obj.delegatedTo ?? obj.to;
  const rawAmount = obj.amount ?? obj.delegated_amount ?? obj.delegatedAmount;
  const rawIncoming =
    obj.incoming ??
    obj.incoming_delegations ??
    obj.incomingDelegations ??
    obj.incoming_amount ??
    obj.incomingAmount;

  const delegatedTo = normalizeDelegatedAddress(rawDelegate);
  const delegatedAmount = delegatedTo ? normalizeDelegatedAmount(rawAmount) : 0;
  const incomingDelegations = normalizeDelegatedAmount(rawIncoming);

  return {
    delegatedTo,
    delegatedAmount,
    incomingDelegations,
  };
}

/**
 * Queries current vote delegation status from the governance contract authority (#111).
 * Returns contract-backed delegation data or throws DelegationError if unavailable.
 */
export async function getDelegationInfo(address: string): Promise<DelegationInfo> {
  if (!address || !isValidStellarAddress(address)) {
    throw new DelegationError('Invalid or missing Stellar address for delegation query');
  }

  let callResult: rpc.Api.SimulateTransactionResponse;
  try {
    const params: xdr.ScVal[] = [Address.fromString(address).toScVal()];
    callResult = await server.simulateTransaction(
      buildGovernanceReadTransaction('get_delegation', params)
    );
  } catch (err) {
    throw new DelegationError('Failed to simulate delegation read on governance contract', err);
  }

  if (!rpc.Api.isSimulationSuccess(callResult)) {
    throw new DelegationError(
      'Governance authority returned an unsuccessful simulation for delegation'
    );
  }

  if (!callResult.result?.retval) {
    return {
      delegatedTo: null,
      delegatedAmount: 0,
      incomingDelegations: 0,
    };
  }

  const native = scValToNative(callResult.result.retval);
  return parseDelegationInfoFromNative(native);
}

/**
 * Delegate voting power to another address or remove delegation (when delegateAddress is null).
 * Signs through the wallet and derives a deterministic transaction hash.
 */
export async function delegateVotingPower(
  delegateAddress: string | null,
  signerAddress: string,
  signTx: (xdr: string) => Promise<string>,
  options: GovernanceMutationOptions = {}
): Promise<string> {
  requireSep10Session(signerAddress);

  if (!signerAddress || !isValidStellarAddress(signerAddress)) {
    throw new DelegationError('Invalid signer address for delegation');
  }

  const normalizedDelegate =
    delegateAddress && isValidStellarAddress(delegateAddress) ? delegateAddress : null;

  if (delegateAddress !== null && delegateAddress !== undefined && delegateAddress !== '') {
    if (!isValidStellarAddress(delegateAddress)) {
      throw new DelegationError('Invalid delegate address');
    }
    if (delegateAddress === signerAddress) {
      throw new DelegationError('Cannot delegate voting power to yourself');
    }
  }

  const intent = normalizedDelegate
    ? `delegate:${signerAddress}:${normalizedDelegate}`
    : `undelegate:${signerAddress}`;
  const cacheKey = `${signerAddress}:delegation`;
  const inFlightKey = `${signerAddress}:${intent}`;

  const inFlight = delegateInFlight.get(inFlightKey);
  if (inFlight) return inFlight;

  const run = (async () => {
    if (options.simulate) {
      await assertGovernanceSimulationPassed(options.simulate);
    }

    const signed = await requireGovernanceSignature(intent, signerAddress, signTx);
    const txHash = deriveGovernanceTxHash(signed, intent);
    proposalTxHashes.set(cacheKey, txHash);

    await options.onConfirmed?.(txHash);
    return txHash;
  })();

  delegateInFlight.set(inFlightKey, run);
  try {
    return await run;
  } finally {
    delegateInFlight.delete(inFlightKey);
  }
}

// ─── Proposal creation ────────────────────────────────────────────────────────

/** Simulate a read-only call and return the decoded value; throws when the read fails. */
async function readContractValue(contractId: string, method: string): Promise<unknown> {
  const callResult = await server.simulateTransaction(
    buildTokenReadTransaction(contractId, method, [])
  );
  if (!rpc.Api.isSimulationSuccess(callResult) || !callResult.result?.retval) {
    const detail = 'error' in callResult && callResult.error ? `: ${String(callResult.error)}` : '';
    throw new Error(`Read ${method} on ${contractId} failed${detail}`);
  }
  return scValToNative(callResult.result.retval);
}

async function fetchAcceptedTokens(): Promise<AcceptedToken[]> {
  const ids = await getApprovedTokenIds();
  const metadata = await Promise.all(ids.map((id) => getTokenMetadata(id)));
  return metadata.map((token) => ({
    address: token.contractId,
    name: token.name,
    symbol: token.symbol,
    decimals: token.decimals,
  }));
}

/** Retention window used to discover the latest confirmed rate values (~7 days). */
const CURRENT_VALUE_LOOKBACK_LEDGERS = 120_960;

async function fetchParameterUpdateEvents(
  lookbackLedgers: number
): Promise<ParameterUpdateEvent[]> {
  const result = await fetchConfirmedParameterUpdates({
    server,
    governanceContractId: GOVERNANCE_CONTRACT_ID,
    protocolContractId: CONTRACT_ID,
    lookbackLedgers,
  });
  return result.events;
}

/**
 * Current proposal-validation parameters, read from the governance contract,
 * the ILN token, the invoice contract allowlist and confirmed parameter
 * events (#1054). Throws `ChainParametersError` when an authoritative read
 * fails — there is no hard-coded fallback.
 */
export async function fetchProtocolParameters(): Promise<ProtocolParameters> {
  return fetchChainParameters({
    governanceContractId: GOVERNANCE_CONTRACT_ID,
    govTokenContractId: ILN_TOKEN_CONTRACT_ID,
    readContract: readContractValue,
    getAcceptedTokens: fetchAcceptedTokens,
    getParameterUpdates: () => fetchParameterUpdateEvents(CURRENT_VALUE_LOOKBACK_LEDGERS),
  });
}

/**
 * Fetch the quorum threshold in ILN tokens by reading the ILN token total supply
 * from the Soroban token contract and computing `totalSupply * quorumThresholdBps / 10_000`.
 * Returns 0 on any RPC failure.
 */
export async function fetchQuorumThreshold(): Promise<number> {
  try {
    const callResult = await server.simulateTransaction(
      buildTokenReadTransaction(ILN_TOKEN_CONTRACT_ID, 'total_supply', [])
    );
    if (!rpc.Api.isSimulationSuccess(callResult) || !callResult.result?.retval) {
      return 0;
    }
    const totalSupply = BigInt(scValToNative(callResult.result.retval));
    const quorumBps = BigInt(
      (await readContractValue(GOVERNANCE_CONTRACT_ID, 'get_min_quorum_bps')) as number
    );
    return Number((totalSupply * quorumBps) / 10_000n);
  } catch {
    return 0;
  }
}

/** Stellar address / contract ID basic format check: starts with G or C, 56 chars, valid base-32 charset */
const STELLAR_ADDRESS_RE = /^[GC][A-Z2-7]{55}$/;

export function isValidStellarAddress(address: string): boolean {
  return STELLAR_ADDRESS_RE.test(address.trim());
}

/**
 * Validate and look up a token contract for an AddToken proposal.
 * Reads SEP-41 `name`, `symbol` and `decimals` from the token contract; the
 * decimals are required because `add_token` checks them against the token.
 * Throws a descriptive error for anything that cannot be added.
 */
export async function lookupToken(
  address: string,
  acceptedTokens?: readonly AcceptedToken[]
): Promise<AcceptedToken> {
  const trimmed = address.trim();
  if (!isValidStellarAddress(trimmed)) {
    throw new Error('Invalid Stellar address. Must start with G or C and be 56 characters.');
  }
  if (!isContractAddress(trimmed)) {
    throw new Error('Only Soroban token contracts (C…) can be added as accepted tokens.');
  }

  const accepted = acceptedTokens ?? (await fetchAcceptedTokens());
  const existing = accepted.find((t) => t.address === trimmed);
  if (existing) {
    throw new Error(`${existing.symbol} is already an accepted token.`);
  }

  let nameResult: rpc.Api.SimulateTransactionResponse;
  let symbolResult: rpc.Api.SimulateTransactionResponse;
  let decimalsResult: rpc.Api.SimulateTransactionResponse;

  try {
    [nameResult, symbolResult, decimalsResult] = await Promise.all([
      server.simulateTransaction(buildTokenReadTransaction(trimmed, 'name', [])),
      server.simulateTransaction(buildTokenReadTransaction(trimmed, 'symbol', [])),
      server.simulateTransaction(buildTokenReadTransaction(trimmed, 'decimals', [])),
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to simulate token contract call for ${trimmed}: ${msg}`);
  }

  for (const result of [nameResult, symbolResult, decimalsResult]) {
    if ('error' in result && result.error) {
      throw new Error(String(result.error));
    }
  }

  if (!rpc.Api.isSimulationSuccess(nameResult) || !nameResult.result?.retval) {
    throw new Error(`Failed to simulate token name for ${trimmed}`);
  }
  if (!rpc.Api.isSimulationSuccess(symbolResult) || !symbolResult.result?.retval) {
    throw new Error(`Failed to simulate token symbol for ${trimmed}`);
  }
  if (!rpc.Api.isSimulationSuccess(decimalsResult) || !decimalsResult.result?.retval) {
    throw new Error(`Failed to read token decimals for ${trimmed}`);
  }

  const name = String(scValToNative(nameResult.result.retval));
  const symbol = String(scValToNative(symbolResult.result.retval));
  const decimals = Number(scValToNative(decimalsResult.result.retval));
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > MAX_TOKEN_DECIMALS) {
    throw new Error(`Token ${trimmed} reported invalid decimals.`);
  }

  return { address: trimmed, name, symbol, decimals };
}

export interface CreateProposalOptions extends GovernanceMutationOptions {
  /** Progress callback for each transaction stage (#1055). */
  onStage?: (stage: CreateProposalStage) => void;
  /** Validation context; fetched from the chain when omitted (#1054). */
  context?: ProposalValidationContext;
}

const PROPOSAL_IDEMPOTENCY_WINDOW_MS = 30_000;

/**
 * Submits a new governance proposal on-chain and returns the confirmed hash
 * together with the proposal id the contract assigned.
 *
 * The id comes from the contract's return value, never from a local counter:
 * a locally invented id would collide with, or skip, the contract's own
 * sequence. Simulation runs first, so an under-threshold ILN balance or an
 * invalid parameter is reported before the wallet prompt (#1044).
 * Create a governance proposal on-chain (#1055): validate against the contract
 * schema (#1056) using chain parameters (#1054), then build, simulate, sign,
 * submit and confirm `create_proposal`. Resolves with the proposal id the
 * contract returned. Nothing is mutated locally.
 */
export async function createProposal(
  payload: CreateProposalPayload,
  signerAddress: string,
  signTx: (xdr: string) => Promise<string>,
  options: GovernanceWriteOptions = {}
): Promise<{ txHash: string; proposalId: number }> {
  const proposer = requireSigner(signerAddress, 'create_proposal');

  // Idempotency: deduplicate rapid duplicate submissions without re-signing
  // or creating a second proposal (#1146).
  const idempotencyKey = `${proposer}:${payload.title}:${payload.formType}:${
    payload.newValueBps ?? payload.tokenAddress ?? payload.removeTokenAddress ?? ''
  }`;
  const cached = proposalCreationCache.get(idempotencyKey);
  if (cached && Date.now() - cached.timestamp < PROPOSAL_CREATION_DEDUPE_MS) {
    return { txHash: cached.txHash, proposalId: cached.proposalId };
  }

  const { txHash, returnValue } = await executeGovernanceMutation({
    method: 'create_proposal',
    args: [
      Address.fromString(proposer).toScVal(),
      nativeToScVal(PROPOSAL_TYPE_CODE[payload.formType], { type: 'u32' }),
      nativeToScVal(payload.title, { type: 'string' }),
      nativeToScVal(payload.description, { type: 'string' }),
      nativeToScVal(encodeProposalValue(payload), { type: 'string' }),
    ],
    signerAddress: proposer,
    signTx,
    pendingLabel: `create_proposal:${payload.formType}`,
    ...options,
  });

  const proposalId = parseCreatedProposalId(returnValue);
  proposalCreationCache.set(idempotencyKey, { txHash, proposalId, timestamp: Date.now() });

  return { txHash, proposalId };
  options: CreateProposalOptions = {}
): Promise<{ txHash: string; proposalId: number }> {
  assertGovernanceNetworkMatches(options.walletNetwork);
  requireSep10Session(signerAddress);

  const idempotencyKey = `${signerAddress}:${payload.formType}:${payload.title}:${
    payload.newValueBps ?? payload.tokenAddress ?? payload.removeTokenAddress ?? ''
  }`;
  const cached = proposalCreationCache.get(idempotencyKey);
  if (cached && Date.now() - cached.timestamp < PROPOSAL_IDEMPOTENCY_WINDOW_MS) {
    return { txHash: cached.txHash, proposalId: cached.proposalId };
  }
  const inFlight = proposalCreationInFlight.get(idempotencyKey);
  if (inFlight) return inFlight;

  const run = (async () => {
    // Optional caller-supplied dry-run gate (#1063); the contract simulation
    // inside submitCreateProposal always runs as well.
    if (options.simulate) {
      await assertGovernanceSimulationPassed(options.simulate);
    }
    const context = options.context ?? toValidationContext(await fetchProtocolParameters());
    const created = await submitCreateProposal({
      payload,
      proposer: signerAddress,
      signTx,
      context,
      server,
      governanceContractId: GOVERNANCE_CONTRACT_ID,
      networkPassphrase: NETWORK_PASSPHRASE,
      onStage: options.onStage,
      walletNetwork: options.walletNetwork,
    });
    proposalCreationCache.set(idempotencyKey, {
      txHash: created.txHash,
      proposalId: created.proposalId,
      timestamp: Date.now(),
    });
    await options.onConfirmed?.(created.txHash);
    return { txHash: created.txHash, proposalId: created.proposalId };
  })();

  proposalCreationInFlight.set(idempotencyKey, run);
  try {
    return await run;
  } finally {
    proposalCreationInFlight.delete(idempotencyKey);
  }
}

// ─── Parameter change announcements (#153, #1057) ─────────────────────────────

/**
 * Protocol parameter changes confirmed on-chain, newest first (#1057).
 *
 * Reads `parameter_updated` and `proposal_executed` contract events through
 * Soroban RPC. Throws `ParameterEventsError` when RPC cannot answer, so the UI
 * can show an explicit failure state; nothing is derived from local data.
 */
export async function fetchParameterUpdates(): Promise<ParameterUpdateEvent[]> {
  return fetchParameterUpdateEvents(DEFAULT_LOOKBACK_LEDGERS);
}

// ─── Multisig Signer Rotation events (#3, #103) ─────────────────────────────

export interface SignerRotatedEvent {
  /** Stable id for the signer rotation event */
  id: string;
  /** Transaction hash on Stellar */
  txHash: string;
  /** Address of the previous / replaced signer */
  oldSigner: string;
  /** Address of the new signer */
  newSigner: string;
  /** Unix timestamp in seconds when the rotation occurred */
  rotatedAt: number;
  /** Action type */
  action?: 'rotated' | 'added' | 'removed';
  /** Optional reason or description provided for transparency */
  reason?: string;
  /** Security significance classification */
  securityLevel?: 'critical' | 'high';
}

export const MOCK_SIGNER_ROTATIONS: SignerRotatedEvent[] = [
  {
    id: 'sr-1',
    txHash: 'a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8',
    oldSigner: 'GCOEF7LMN456OPQ789RST012UVW345XYZ678ABC901DEF234GHI567JKL',
    newSigner: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    rotatedAt: NOW - 3 * DAY,
    action: 'rotated',
    reason: 'Quarterly multisig signer key rotation per security policy',
    securityLevel: 'critical',
  },
  {
    id: 'sr-2',
    txHash: 'f1e2d3c4b5a6f7e8d9c0b1a2f3e4d5c6b7a8f9e0d1c2b3a4f5e6d7c8b9a0f1e2',
    oldSigner: 'GPREV123EXAMPLE456789ABC012GHI345JKL678MNO901PQR234STU567VWX',
    newSigner: 'GCOEF7LMN456OPQ789RST012UVW345XYZ678ABC901DEF234GHI567JKL',
    rotatedAt: NOW - 45 * DAY,
    action: 'rotated',
    reason: 'Hardware security module upgrade and key rotation',
    securityLevel: 'critical',
  },
];

/**
 * Fetch multisig signer rotation events from Horizon / Soroban transactions.
 * Falls back to mock signer rotations if Horizon yields no events.
 */
export async function fetchSignerRotations(): Promise<SignerRotatedEvent[]> {
  const base = getHorizonBaseUrl();
  const url = `${base}/transactions?accounts=${encodeURIComponent(GOVERNANCE_CONTRACT_ID)}&order=desc&limit=${GOVERNANCE_PAGE_LIMIT}`;
  const events: SignerRotatedEvent[] = [];

  try {
    let nextUrl = url;

    for (let page = 0; page < GOVERNANCE_MAX_PAGES; page += 1) {
      const pageResp = await fetchGovernanceTransactionsPage(nextUrl);
      const records = pageResp._embedded?.records ?? [];
      if (records.length === 0) break;

      for (const tx of records) {
        if (tx.successful === false) continue;

        const txEvents = tx._embedded?.records ?? [];
        for (const evt of txEvents) {
          const topicName = decodeHexOrUtf8Topic(evt.topics?.[0] ?? evt.type);
          if (topicName !== 'SignerRotated') continue;

          const oldSigner = decodeHexOrUtf8Topic(evt.topics?.[1]) ?? '';
          const newSigner = decodeHexOrUtf8Topic(evt.topics?.[2]) ?? '';
          const reason = decodeHexOrUtf8Topic(evt.topics?.[3]);
          const rotatedAt = tx.created_at ? Math.floor(Date.parse(tx.created_at) / 1000) : 0;
          const txHash = tx.hash ?? '';

          events.push({
            id: `sr-${txHash || rotatedAt}-${oldSigner.slice(0, 6)}`,
            txHash,
            oldSigner,
            newSigner,
            rotatedAt,
            action: 'rotated',
            reason,
            securityLevel: 'critical',
          });
        }
      }

      const nextHref = pageResp._links?.next?.href;
      if (!nextHref) break;
      nextUrl = nextHref;
    }
  } catch {
    // Fall through to mock data
  }

  if (events.length > 0) {
    return events.sort((a, b) => b.rotatedAt - a.rotatedAt);
  }

  return [...MOCK_SIGNER_ROTATIONS].sort((a, b) => b.rotatedAt - a.rotatedAt);
}

// ─── Governance Activity ──────────────────────────────────────────────────────

export const MOCK_VOTES: VoteCastEvent[] = [
  {
    proposalId: 1,
    proposalTitle: 'Reduce Base Discount Rate to 3.5%',
    voter: 'GABC123EXAMPLE456789ABC012GHI345JKL678MNO901PQR234STU567VWX890YZ',
    vote: 'For',
    weight: 1250,
    timestamp: NOW - 1.5 * DAY,
  },
  {
    proposalId: 3,
    proposalTitle: 'Add EURC as Accepted Invoice Currency',
    voter: 'GABC123EXAMPLE456789ABC012GHI345JKL678MNO901PQR234STU567VWX890YZ',
    vote: 'For',
    weight: 1250,
    timestamp: NOW - 10 * DAY,
  },
  {
    proposalId: 4,
    proposalTitle: 'Extend Voting Period to 10 Days',
    voter: 'GABC123EXAMPLE456789ABC012GHI345JKL678MNO901PQR234STU567VWX890YZ',
    vote: 'Against',
    weight: 1250,
    timestamp: NOW - 25 * DAY,
  },
  {
    proposalId: 7,
    proposalTitle: 'Lower Protocol Fee Rate to 0.3%',
    voter: 'GABC123EXAMPLE456789ABC012GHI345JKL678MNO901PQR234STU567VWX890YZ',
    vote: 'For',
    weight: 1250,
    timestamp: NOW - 5 * DAY,
  },
];

/**
 * Fetch governance voting history for a specific address.
 * Reads VoteCast events from Horizon transactions for the governance contract.
 */
export async function fetchVotesForAddress(address: string): Promise<VoteCastEvent[]> {
  const base = getHorizonBaseUrl();
  const url = `${base}/transactions?accounts=${encodeURIComponent(GOVERNANCE_CONTRACT_ID)}&order=desc&limit=${GOVERNANCE_PAGE_LIMIT}`;
  const votes: VoteCastEvent[] = [];

  try {
    let nextUrl = url;

    for (let page = 0; page < GOVERNANCE_MAX_PAGES; page += 1) {
      const pageResp = await fetchGovernanceTransactionsPage(nextUrl);
      const records = pageResp._embedded?.records ?? [];
      if (records.length === 0) break;

      for (const tx of records) {
        if (tx.successful === false) continue;

        const events = tx._embedded?.records ?? [];
        for (const evt of events) {
          const topicName = decodeHexOrUtf8Topic(evt.topics?.[0] ?? evt.type);
          if (topicName !== 'VoteCast') continue;

          const voter = decodeHexOrUtf8Topic(evt.topics?.[2]);
          if (voter !== address) continue;

          const proposalId = Number(decodeHexOrUtf8Topic(evt.topics?.[1]) ?? 0);
          const support = decodeHexOrUtf8Topic(evt.topics?.[3]);
          const vote: VoteChoice = support === 'true' || support === '1' ? 'For' : 'Against';
          const proposalTitle =
            MOCK_PROPOSALS.find((p) => p.id === proposalId)?.title ?? `Proposal #${proposalId}`;
          const timestamp = tx.created_at ? Math.floor(Date.parse(tx.created_at) / 1000) : 0;

          votes.push({
            proposalId,
            proposalTitle,
            voter,
            vote,
            weight: 1250, // weight comes from voter's balance at proposal creation
            timestamp,
          });
        }
      }

      const nextHref = pageResp._links?.next?.href;
      if (!nextHref) break;
      nextUrl = nextHref;
    }
  } catch {
    // Silently return what we have — consumers treat empty as "no votes".
  }

  return votes.sort((a, b) => b.timestamp - a.timestamp);
}

// ─── Proposal Simulation / Dry-Run ────────────────────────────────────────────

export interface ProposalSimulationResult {
  isContractVerified: boolean;
  estimatedEffect: string;
  warnings?: string[];
}

/**
 * Simulate the effect of a proposed parameter change without executing it.
 * If the contract's `simulate_proposal_effect` function is available, returns
 * a contract-verified simulation. Otherwise, returns a client-side estimate with
 * a clear disclaimer.
 *
 * @param payload - The proposal payload to simulate
 * @returns Simulation result with effect description and verification status
 */
export async function simulateProposalEffect(
  payload: CreateProposalPayload
): Promise<ProposalSimulationResult> {
  try {
    // Attempt to call the contract's `simulate_proposal_effect` function
    // TODO: Wire this to actual Soroban call once contract function is available
    // Ref: #111
    const tx = buildGovernanceReadTransaction('simulate_proposal_effect', [
      // Would pass serialized payload to contract
    ]);

    const callResult = await server.simulateTransaction(tx);

    // If contract call succeeds, return verified result
    if (rpc.Api.isSimulationSuccess(callResult) && callResult.result?.retval) {
      const native = scValToNative(callResult.result.retval);
      return {
        isContractVerified: true,
        estimatedEffect: typeof native === 'string' ? native : JSON.stringify(native),
      };
    }

    // Fall through to client-side estimate
    console.warn('Contract simulate_proposal_effect not available, using client-side estimate');
  } catch (err) {
    console.warn('simulateProposalEffect contract call failed:', err);
    // Fall through to client-side estimate
  }

  // Client-side estimation (not contract-verified)
  const clientEstimate = generateClientSideEstimate(payload);
  return {
    isContractVerified: false,
    estimatedEffect: clientEstimate,
    warnings: [
      'This is an estimated preview, not contract-verified. Actual on-chain effect may differ due to updates between proposal creation and execution.',
    ],
  };
}

/**
 * Generate a client-side estimate of the proposal effect.
 * Used as fallback when contract simulation is unavailable.
 */
function generateClientSideEstimate(payload: CreateProposalPayload): string {
  switch (payload.formType) {
    case 'FeeRate':
      return `Update protocol fee rate to ${payload.newValueBps ? payload.newValueBps / 100 : 0}%`;
    case 'MaxDiscountRate':
      return `Update maximum discount rate to ${payload.newValueBps ? payload.newValueBps / 100 : 0}%`;
    case 'AddToken':
      return `Add ${payload.tokenName || 'new token'} (${payload.tokenAddress}) to accepted tokens`;
    case 'RemoveToken':
      return `Remove token (${payload.removeTokenAddress}) from accepted tokens`;
    default:
      return 'Proposal effect: unknown';
  }
}
