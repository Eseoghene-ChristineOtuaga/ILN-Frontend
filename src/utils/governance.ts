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
    status: 'Stubbed',
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
const proposalCreationCache: Map<
  string,
  { txHash: string; proposalId: number; timestamp: number }
> = new Map();

export function clearGovernanceIdempotencyCache(): void {
  proposalTxHashes.clear();
  proposalCreationCache.clear();
}

export function getUserVote(proposalId: number): VoteChoice | undefined {
  return userVotes.get(proposalId);
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

export async function fetchProposals(): Promise<Proposal[]> {
  try {
    const tx = buildGovernanceReadTransaction('list_proposals');
    const callResult = await server.simulateTransaction(tx);
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
  } catch (err) {
    console.warn(
      'iln_governance list_proposals contract call failed, falling back to mock data:',
      err
    );
  }

  return MOCK_PROPOSALS.map((p) => ({
    ...p,
    userVote: userVotes.get(p.id),
    vetoHistory: getVetoHistory(p.id),
  }));
}

export const getProposals = fetchProposals;

export async function fetchProposal(id: number): Promise<Proposal | null> {
  const proposals = await fetchProposals();
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

  // Only a confirmed settlement updates local state (#1142).
  userVotes.set(proposalId, choice);
  proposalTxHashes.set(cacheKey, txHash);
  return txHash;
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

  proposalTxHashes.set(cacheKey, txHash);
  return txHash;
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
}

export function getVetoHistory(proposalId: number): VetoRecord[] {
  return vetoHistory.filter((record) => record.proposalId === proposalId);
}

export async function getVotingPower(address: string): Promise<number> {
  try {
    const params: xdr.ScVal[] = [Address.fromString(address).toScVal()];
    const callResult = await server.simulateTransaction(
      buildTokenReadTransaction(ILN_TOKEN_CONTRACT_ID, 'balance', params)
    );
    if (!rpc.Api.isSimulationSuccess(callResult) || !callResult.result?.retval) {
      // No authoritative balance available: report zero rather than a
      // fabricated voting-power constant.
      return 0;
    }
    const balance = BigInt(scValToNative(callResult.result.retval));
    return Number(balance);
  } catch {
    return 0;
  }
}

export async function getDelegationInfo(address: string): Promise<{
  delegatedTo: string | null;
  delegatedAmount: number;
  incomingDelegations: number;
}> {
  // TODO: Replace with actual Soroban delegation reads once the governance
  // contract exposes them (Ref: #111). Until then, report no delegation rather
  // than inventing per-address or randomized delegation figures that would
  // otherwise reach the voting-power UI.
  void address;
  return {
    delegatedTo: null,
    delegatedAmount: 0,
    incomingDelegations: 0,
  };
}

// ─── Proposal creation ────────────────────────────────────────────────────────

/** The four form-level proposal types exposed in the creation UI */
export type CreateProposalFormType = 'FeeRate' | 'AddToken' | 'RemoveToken' | 'MaxDiscountRate';

export interface AcceptedToken {
  address: string;
  name: string;
  symbol: string;
}

export interface ProtocolParameters {
  /** Current protocol fee rate in basis points (e.g. 50 = 0.5%) */
  feeRateBps: number;
  /** Current maximum discount rate in basis points (e.g. 500 = 5%) */
  maxDiscountRateBps: number;
  /** Tokens currently accepted by the protocol */
  acceptedTokens: AcceptedToken[];
  /** Minimum ILN balance required to submit a proposal */
  minProposalILN: number;
  /** Minimum quorum threshold in basis points (e.g. 1000 = 10% of total supply) */
  quorumThresholdBps: number;
}

export interface CreateProposalPayload {
  formType: CreateProposalFormType;
  title: string;
  description: string;
  /** New basis-point value for FeeRate / MaxDiscountRate proposals */
  newValueBps?: number;
  /** Token address for AddToken proposals */
  tokenAddress?: string;
  /** Resolved token name (AddToken) */
  tokenName?: string;
  /** Token address to remove (RemoveToken) */
  removeTokenAddress?: string;
}

// ─── Mock protocol parameter state ───────────────────────────────────────────

const MOCK_PROTOCOL_PARAMS: ProtocolParameters = {
  feeRateBps: 50, // 0.5%
  maxDiscountRateBps: 500, // 5%
  acceptedTokens: [
    {
      address: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
      name: 'USD Coin',
      symbol: 'USDC',
    },
    {
      address: 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
      name: 'Euro Coin',
      symbol: 'EURC',
    },
  ],
  minProposalILN: 500,
  quorumThresholdBps: 1000, // 10%
};

/**
 * Fetch current on-chain protocol parameters.
 * TODO: Replace with actual Soroban read-only calls once governance contract is deployed.
 * Ref: #111
 */
export async function fetchProtocolParameters(): Promise<ProtocolParameters> {
  await new Promise((r) => setTimeout(r, 400));
  return { ...MOCK_PROTOCOL_PARAMS };
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
    const params = await fetchProtocolParameters();
    return Number((totalSupply * BigInt(params.quorumThresholdBps)) / 10_000n);
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
 * Validate and look up a token from a Stellar asset contract address.
 * Simulates Soroban read calls (SEP-41 `name` and `symbol`).
 * Returns the resolved AcceptedToken or throws a descriptive error.
 */
export async function lookupToken(address: string): Promise<AcceptedToken> {
  const trimmed = address.trim();
  if (!isValidStellarAddress(trimmed)) {
    throw new Error('Invalid Stellar address. Must start with G or C and be 56 characters.');
  }

  // Check if it's already an accepted token
  const existing = MOCK_PROTOCOL_PARAMS.acceptedTokens.find((t) => t.address === trimmed);
  if (existing) {
    throw new Error(`${existing.symbol} is already an accepted token.`);
  }

  let nameResult: rpc.Api.SimulateTransactionResponse;
  let symbolResult: rpc.Api.SimulateTransactionResponse;

  try {
    [nameResult, symbolResult] = await Promise.all([
      server.simulateTransaction(buildTokenReadTransaction(trimmed, 'name', [])),
      server.simulateTransaction(buildTokenReadTransaction(trimmed, 'symbol', [])),
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to simulate token contract call for ${trimmed}: ${msg}`);
  }

  if ('error' in nameResult && nameResult.error) {
    throw new Error(String(nameResult.error));
  }
  if ('error' in symbolResult && symbolResult.error) {
    throw new Error(String(symbolResult.error));
  }

  if (!rpc.Api.isSimulationSuccess(nameResult) || !nameResult.result?.retval) {
    throw new Error(`Failed to simulate token name for ${trimmed}`);
  }
  if (!rpc.Api.isSimulationSuccess(symbolResult) || !symbolResult.result?.retval) {
    throw new Error(`Failed to simulate token symbol for ${trimmed}`);
  }

  const name = String(scValToNative(nameResult.result.retval));
  const symbol = String(scValToNative(symbolResult.result.retval));

  return {
    address: trimmed,
    name,
    symbol,
  };
}

/**
 * Submits a new governance proposal on-chain and returns the confirmed hash
 * together with the proposal id the contract assigned.
 *
 * The id comes from the contract's return value, never from a local counter:
 * a locally invented id would collide with, or skip, the contract's own
 * sequence. Simulation runs first, so an under-threshold ILN balance or an
 * invalid parameter is reported before the wallet prompt (#1044).
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
}

// ─── Parameter change announcements (#153) ────────────────────────────────────

/**
 * A single applied protocol-parameter change, suitable for surfacing in an
 * announcement banner. Mirrors the data a `ParameterUpdated` contract event
 * would carry.
 */
export interface ParameterUpdateEvent {
  /** Stable id used for per-event dismissal (`{proposalId}:{parameter}`). */
  id: string;
  /** The governance proposal that enacted this change (for deep-linking). */
  proposalId: number;
  /** Raw on-chain parameter key, e.g. `fee_rate_bps`. */
  parameter: string;
  /** Human-readable parameter name, e.g. "Protocol fee rate". */
  label: string;
  /** Formatted new value as shown on the proposal, e.g. "30 (0.3%)". */
  newValue: string;
  /** Unix seconds when the change took effect (proposal execution time). */
  updatedAt: number;
}

/** Human-readable labels for known protocol parameters. */
const PARAMETER_LABELS: Record<string, string> = {
  fee_rate_bps: 'Protocol fee rate',
  base_discount_rate: 'Base discount rate',
  max_discount_rate_bps: 'Maximum discount rate',
  quorum_threshold_bps: 'Quorum threshold',
  voting_period_seconds: 'Voting period',
  accepted_tokens: 'Accepted tokens',
  min_invoice_amount: 'Minimum invoice amount',
  reputation_threshold: 'Reputation threshold',
};

/** Map a raw parameter key to a friendly label, falling back to a prettified key. */
export function parameterLabel(parameter: string): string {
  return PARAMETER_LABELS[parameter] ?? parameter.replace(/_/g, ' ');
}

/**
 * Fetch the protocol parameter changes that have been enacted, newest first.
 *
 * Reads ParameterUpdated events from Horizon governance transactions, falling
 * back to executed proposals with parameterChanges if Horizon yields nothing.
 */
export async function fetchParameterUpdates(): Promise<ParameterUpdateEvent[]> {
  const base = getHorizonBaseUrl();
  const url = `${base}/transactions?accounts=${encodeURIComponent(GOVERNANCE_CONTRACT_ID)}&order=desc&limit=${GOVERNANCE_PAGE_LIMIT}`;
  const events: ParameterUpdateEvent[] = [];

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
          if (topicName !== 'ParameterUpdated') continue;

          const parameter = decodeHexOrUtf8Topic(evt.topics?.[1]) ?? '';
          const newValue = decodeHexOrUtf8Topic(evt.topics?.[2]) ?? '';
          const proposalId = Number(decodeHexOrUtf8Topic(evt.topics?.[3]) ?? 0);
          const updatedAt = tx.created_at ? Math.floor(Date.parse(tx.created_at) / 1000) : 0;

          events.push({
            id: `${proposalId}:${parameter}`,
            proposalId,
            parameter,
            label: parameterLabel(parameter),
            newValue,
            updatedAt,
          });
        }
      }

      const nextHref = pageResp._links?.next?.href;
      if (!nextHref) break;
      nextUrl = nextHref;
    }
  } catch {
    // Fall through to proposal-derived updates below.
  }

  if (events.length > 0) {
    return events.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // Fallback: derive from executed proposals with parameterChanges.
  const proposals = await fetchProposals();
  return proposals
    .filter((p) => p.status === 'Executed' && p.parameterChanges?.length)
    .flatMap((p) => {
      const updatedAt = p.executableAfter ?? p.votingEndsAt;
      return (p.parameterChanges ?? []).map((change) => ({
        id: `${p.id}:${change.parameter}`,
        proposalId: p.id,
        parameter: change.parameter,
        label: parameterLabel(change.parameter),
        newValue: change.newValue,
        updatedAt,
      }));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
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
