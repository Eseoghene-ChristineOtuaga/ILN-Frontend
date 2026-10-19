/**
 * Confirmed protocol-parameter changes from contract events (#1057).
 *
 * Announcements are driven only by events the contracts emitted in
 * successful transactions — never by local assumptions or by inferring what
 * an executed proposal "should" have changed.
 *
 * Event shapes (Invoice-Liquidity-Network/ILN-Smart-Contract):
 *
 *   iln_governance      topics (Symbol "parameter_updated", Symbol param_name)
 *                       value  GovernanceParameterUpdated { param_name, old_value: i128, new_value: i128 }
 *   invoice_liquidity   topics (Symbol "parameter_updated", Symbol param_name, Address updated_by)
 *                       value  ParameterUpdated { param_name, old_value: i128, new_value: i128, updated_by }
 *   iln_governance      topics (Symbol "proposal_executed", u64 proposal_id)
 *                       value  ProposalExecuted { proposal_id, action_type, proposed_value, votes_for, votes_against }
 *
 * A proposal's cross-contract call (e.g. `update_fee_rate`) and its
 * `proposal_executed` event land in the same transaction, which is how a
 * parameter change is linked back to the proposal that enacted it. Token
 * allowlist changes emit no `parameter_updated` event, so they are taken from
 * `proposal_executed` with an `AddToken` / `RemoveToken` action.
 *
 * Soroban RPC only retains events for a limited window (about 7 days on public
 * RPC). Older changes are outside what this module can confirm; callers are
 * told the window they covered instead of being given a fallback.
 */

import { rpc, scValToNative, nativeToScVal, xdr } from '@stellar/stellar-sdk';

export const PARAMETER_UPDATED_TOPIC = 'parameter_updated';
export const PROPOSAL_EXECUTED_TOPIC = 'proposal_executed';

/** ~48 hours of ledgers at ~5s per ledger: the announcement window. */
export const DEFAULT_LOOKBACK_LEDGERS = 34_560;
const MAX_PAGES = 20;
const PAGE_LIMIT = 200;

export type ParameterSource = 'governance' | 'protocol';

/** A single confirmed parameter change, newest-first when listed. */
export interface ParameterUpdateEvent {
  /** Stable id for per-event dismissal: `{txHash}:{parameter}`. */
  id: string;
  /** Proposal that enacted the change; `null` for direct admin/governance writes. */
  proposalId: number | null;
  /** On-chain parameter key, e.g. `protocol_fee_rate_bps`. */
  parameter: string;
  /** Human-readable parameter name. */
  label: string;
  /** Formatted previous value, when the event carries one. */
  oldValue: string | null;
  /** Formatted new value, e.g. "30 (0.3%)". */
  newValue: string;
  /** Raw new value as emitted (i128 for numeric parameters). */
  rawNewValue: bigint | null;
  /** Unix seconds of the ledger that confirmed the change. */
  updatedAt: number;
  ledger: number;
  txHash: string;
  /** Which contract emitted the change. */
  source: ParameterSource;
}

export interface ParameterUpdatesResult {
  events: ParameterUpdateEvent[];
  /** Ledger range actually scanned, after clamping to RPC retention. */
  scannedFromLedger: number;
  scannedToLedger: number;
}

export class ParameterEventsError extends Error {
  readonly code = 'PARAMETER_EVENTS_UNAVAILABLE';

  constructor(detail: string, options?: { cause?: unknown }) {
    super(`PARAMETER_EVENTS_UNAVAILABLE: ${detail}`, options);
    this.name = 'ParameterEventsError';
  }
}

type EventsServer = Pick<rpc.Server, 'getEvents' | 'getLatestLedger'>;

export interface FetchParameterUpdatesOptions {
  server: EventsServer;
  governanceContractId: string;
  protocolContractId: string;
  lookbackLedgers?: number;
}

// ─── Labels and formatting ────────────────────────────────────────────────────

const PARAMETER_LABELS: Record<string, string> = {
  protocol_fee_rate_bps: 'Protocol fee rate',
  max_discount_rate_bps: 'Maximum discount rate',
  accepted_tokens: 'Accepted tokens',
  min_quorum_bps: 'Quorum threshold',
  min_proposal_balance: 'Minimum proposer balance',
  min_proposal_deposit: 'Proposal deposit',
  gov_token_total_supply: 'Governance token supply',
  quadratic_voting_enabled: 'Quadratic voting',
  execution_delay: 'Execution delay',
  // Labels for keys used by older announcement data.
  fee_rate_bps: 'Protocol fee rate',
  base_discount_rate: 'Base discount rate',
  quorum_threshold_bps: 'Quorum threshold',
  voting_period_seconds: 'Voting period',
  min_invoice_amount: 'Minimum invoice amount',
  reputation_threshold: 'Reputation threshold',
};

/** Map a raw parameter key to a friendly label, falling back to a prettified key. */
export function parameterLabel(parameter: string): string {
  return PARAMETER_LABELS[parameter] ?? parameter.replace(/_/g, ' ');
}

const BPS_PARAMETERS = new Set([
  'protocol_fee_rate_bps',
  'max_discount_rate_bps',
  'min_quorum_bps',
  'fee_rate_bps',
  'quorum_threshold_bps',
]);

function formatBps(value: bigint): string {
  const pct = Number(value) / 100;
  return `${value.toString()} (${Number.isInteger(pct) ? pct : pct.toString()}%)`;
}

/** Format a raw parameter value for display, based on the parameter's unit. */
export function formatParameterValue(parameter: string, value: bigint): string {
  if (BPS_PARAMETERS.has(parameter)) return formatBps(value);
  if (parameter === 'quadratic_voting_enabled') return value === 0n ? 'Disabled' : 'Enabled';
  if (parameter === 'execution_delay') return `${value.toString()} ledgers`;
  return value.toString();
}

// ─── Decoding ─────────────────────────────────────────────────────────────────

function symbolTopic(name: string): string {
  return nativeToScVal(name, { type: 'symbol' }).toXDR('base64');
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'boolean') return value ? 1n : 0n;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  return null;
}

function native(value: xdr.ScVal): unknown {
  try {
    return scValToNative(value);
  } catch {
    return undefined;
  }
}

function ledgerTimestamp(event: rpc.Api.EventResponse): number {
  const ms = Date.parse(event.ledgerClosedAt);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

function contractIdOf(event: rpc.Api.EventResponse): string {
  const id = event.contractId as unknown;
  if (typeof id === 'string') return id;
  if (id && typeof (id as { contractId?: () => string }).contractId === 'function') {
    return (id as { contractId: () => string }).contractId();
  }
  return '';
}

/**
 * Decode a `ProposalAction` enum value. `scValToNative` turns a tuple-variant
 * `Vec[Symbol, ...fields]` into `[name, ...fields]`.
 */
function decodeAction(value: unknown): { name: string; fields: unknown[] } | null {
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return { name: value[0], fields: value.slice(1) };
  }
  return null;
}

// ─── Fetching ─────────────────────────────────────────────────────────────────

/** Parse `startLedger must be between the oldest ledger: X ...` style RPC errors. */
function oldestLedgerFromError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = message.match(/oldest ledger:?\s*(\d+)/i);
  return match ? Number(match[1]) : null;
}

async function collectEvents(
  server: EventsServer,
  filters: rpc.Api.EventFilter[],
  startLedger: number
): Promise<{ events: rpc.Api.EventResponse[]; latestLedger: number }> {
  const events: rpc.Api.EventResponse[] = [];
  let response = await server.getEvents({ filters, startLedger, limit: PAGE_LIMIT });
  events.push(...response.events);
  for (let page = 1; page < MAX_PAGES && response.events.length === PAGE_LIMIT; page += 1) {
    response = await server.getEvents({ filters, cursor: response.cursor, limit: PAGE_LIMIT });
    events.push(...response.events);
  }
  return { events, latestLedger: response.latestLedger };
}

/**
 * Read confirmed parameter changes from the governance and invoice contracts.
 * Throws {@link ParameterEventsError} when RPC cannot answer: there is no
 * fallback to locally-derived data.
 */
export async function fetchConfirmedParameterUpdates({
  server,
  governanceContractId,
  protocolContractId,
  lookbackLedgers = DEFAULT_LOOKBACK_LEDGERS,
}: FetchParameterUpdatesOptions): Promise<ParameterUpdatesResult> {
  const updated = symbolTopic(PARAMETER_UPDATED_TOPIC);
  const executed = symbolTopic(PROPOSAL_EXECUTED_TOPIC);
  const filters: rpc.Api.EventFilter[] = [
    { type: 'contract', contractIds: [governanceContractId], topics: [[updated, '*']] },
    { type: 'contract', contractIds: [protocolContractId], topics: [[updated, '*', '*']] },
    { type: 'contract', contractIds: [governanceContractId], topics: [[executed, '*']] },
  ];

  let latest: number;
  try {
    latest = (await server.getLatestLedger()).sequence;
  } catch (error) {
    throw new ParameterEventsError('Unable to read the latest ledger from RPC.', { cause: error });
  }

  let startLedger = Math.max(1, latest - Math.max(1, Math.floor(lookbackLedgers)));
  let collected: { events: rpc.Api.EventResponse[]; latestLedger: number };
  try {
    collected = await collectEvents(server, filters, startLedger);
  } catch (error) {
    // The lookback reached past RPC retention: rescan from the oldest
    // retained ledger once, and report the narrower window honestly.
    const oldest = oldestLedgerFromError(error);
    if (oldest === null || oldest <= startLedger) {
      throw new ParameterEventsError('Unable to read contract events from RPC.', { cause: error });
    }
    startLedger = oldest;
    try {
      collected = await collectEvents(server, filters, startLedger);
    } catch (retryError) {
      throw new ParameterEventsError('Unable to read contract events from RPC.', {
        cause: retryError,
      });
    }
  }

  const confirmed = collected.events.filter((event) => event.inSuccessfulContractCall !== false);

  // proposal_executed in the same transaction ties a change to its proposal.
  const proposalByTx = new Map<string, number>();
  const tokenChanges: ParameterUpdateEvent[] = [];
  for (const event of confirmed) {
    const topicName = native(event.topic[0]);
    if (topicName !== PROPOSAL_EXECUTED_TOPIC) continue;
    const body = native(event.value) as
      | { proposal_id?: unknown; action_type?: unknown }
      | undefined;
    const proposalId = toBigInt(body?.proposal_id ?? native(event.topic[1]));
    if (proposalId === null) continue;
    proposalByTx.set(event.txHash, Number(proposalId));

    const action = decodeAction(body?.action_type);
    if (action && (action.name === 'AddToken' || action.name === 'RemoveToken')) {
      const token = String(action.fields[0] ?? '');
      tokenChanges.push({
        id: `${event.txHash}:accepted_tokens`,
        proposalId: Number(proposalId),
        parameter: 'accepted_tokens',
        label: parameterLabel('accepted_tokens'),
        oldValue: null,
        newValue: `${action.name === 'AddToken' ? 'Added' : 'Removed'} ${token}`,
        rawNewValue: null,
        updatedAt: ledgerTimestamp(event),
        ledger: event.ledger,
        txHash: event.txHash,
        source: 'governance',
      });
    }
  }

  const parameterChanges: ParameterUpdateEvent[] = [];
  for (const event of confirmed) {
    const topicName = native(event.topic[0]);
    if (topicName !== PARAMETER_UPDATED_TOPIC) continue;
    const body = native(event.value) as
      | { param_name?: unknown; old_value?: unknown; new_value?: unknown }
      | undefined;
    const parameter = String(body?.param_name ?? native(event.topic[1]) ?? '');
    const newValue = toBigInt(body?.new_value);
    if (!parameter || newValue === null) continue;
    const oldValue = toBigInt(body?.old_value);
    const source: ParameterSource =
      contractIdOf(event) === protocolContractId ? 'protocol' : 'governance';

    parameterChanges.push({
      id: `${event.txHash}:${parameter}`,
      proposalId: proposalByTx.get(event.txHash) ?? null,
      parameter,
      label: parameterLabel(parameter),
      oldValue: oldValue === null ? null : formatParameterValue(parameter, oldValue),
      newValue: formatParameterValue(parameter, newValue),
      rawNewValue: newValue,
      updatedAt: ledgerTimestamp(event),
      ledger: event.ledger,
      txHash: event.txHash,
      source,
    });
  }

  const events = [...parameterChanges, ...tokenChanges].sort(
    (a, b) => b.ledger - a.ledger || b.updatedAt - a.updatedAt
  );
  return { events, scannedFromLedger: startLedger, scannedToLedger: collected.latestLedger };
}

/**
 * Latest confirmed value for each parameter in `events` (newest-first input).
 * Parameters with no confirmed change in the scanned window are absent.
 */
export function latestParameterValues(events: ParameterUpdateEvent[]): Map<string, bigint> {
  const latest = new Map<string, bigint>();
  for (const event of events) {
    if (event.rawNewValue !== null && !latest.has(event.parameter)) {
      latest.set(event.parameter, event.rawNewValue);
    }
  }
  return latest;
}
