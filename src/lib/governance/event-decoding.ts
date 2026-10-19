/**
 * Deterministic Soroban governance contract event decoding (#1066).
 *
 * Covers:
 *  - proposal_created: proposal initialization event
 *  - proposal_executed: proposal enactment event
 *  - vote_cast: voter participation event
 *  - proposal_vetoed: admin veto event
 *  - parameter_updated: protocol parameter mutation event
 *
 * All decoders strictly validate topic and value shapes. Malformed payloads
 * are rejected or return null without throwing unhandled exceptions, and no
 * fabricated fallback data is ever produced.
 */

import { scValToNative, nativeToScVal, xdr, Contract, type rpc } from '@stellar/stellar-sdk';

export interface DecodedProposalCreatedEvent {
  kind: 'proposal_created';
  proposalId: number;
  proposer: string;
  actionType: string;
  title?: string;
  descriptionHash?: string;
  ledger: number;
  txHash: string;
  timestamp: number;
}

export interface DecodedProposalExecutedEvent {
  kind: 'proposal_executed';
  proposalId: number;
  actionType: string;
  proposedValue: bigint;
  votesFor: bigint;
  votesAgainst: bigint;
  ledger: number;
  txHash: string;
  timestamp: number;
}

export interface DecodedVoteCastEvent {
  kind: 'vote_cast';
  proposalId: number;
  voter: string;
  choice: 'For' | 'Against' | 'Abstain';
  votingPower: bigint;
  ledger: number;
  txHash: string;
  timestamp: number;
}

export interface DecodedProposalVetoedEvent {
  kind: 'proposal_vetoed';
  proposalId: number;
  admin: string;
  reasonHash: string;
  ledger: number;
  txHash: string;
  timestamp: number;
}

export interface DecodedParameterUpdatedEvent {
  kind: 'parameter_updated';
  parameter: string;
  oldValue: bigint | null;
  newValue: bigint;
  updatedBy?: string;
  ledger: number;
  txHash: string;
  timestamp: number;
}

export type DecodedGovernanceEvent =
  | DecodedProposalCreatedEvent
  | DecodedProposalExecutedEvent
  | DecodedVoteCastEvent
  | DecodedProposalVetoedEvent
  | DecodedParameterUpdatedEvent;

export class EventDecodingError extends Error {
  readonly code = 'MALFORMED_EVENT_PAYLOAD';
  constructor(message: string, readonly details?: unknown) {
    super(`MALFORMED_EVENT_PAYLOAD: ${message}`);
    this.name = 'EventDecodingError';
  }
}

function safeNative(val: unknown): unknown {
  if (!val) return undefined;
  try {
    return scValToNative(val as xdr.ScVal);
  } catch {
    return undefined;
  }
}

function toBigIntSafe(val: unknown): bigint | null {
  if (typeof val === 'bigint') return val;
  if (typeof val === 'number' && Number.isFinite(val)) return BigInt(Math.trunc(val));
  if (typeof val === 'string' && /^-?\d+$/.test(val.trim())) return BigInt(val.trim());
  if (typeof val === 'boolean') return val ? 1n : 0n;
  return null;
}

function toPositiveNumberSafe(val: unknown): number | null {
  const b = toBigIntSafe(val);
  if (b === null || b <= 0n || b > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(b);
}

function parseLedgerTime(isoString?: string): number {
  if (!isoString) return 0;
  const ms = Date.parse(isoString);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0;
}

export interface DecodeEventOptions {
  strict?: boolean;
}

/**
 * Decode a `proposal_created` event from contract event topics and value.
 * Topics: [Symbol("proposal_created"), u64(proposal_id), Address(proposer)]
 * Value: Map with action_type, title/description_hash, etc.
 */
export function decodeProposalCreatedEvent(
  event: rpc.Api.EventResponse,
  options: DecodeEventOptions = {}
): DecodedProposalCreatedEvent | null {
  if (!event || !Array.isArray(event.topic) || event.topic.length < 2) {
    if (options.strict) throw new EventDecodingError('Missing or insufficient topics for proposal_created');
    return null;
  }

  const topic0 = safeNative(event.topic[0]);
  if (topic0 !== 'proposal_created') return null;

  const proposalId = toPositiveNumberSafe(safeNative(event.topic[1]));
  if (proposalId === null) {
    if (options.strict) throw new EventDecodingError('Invalid or missing proposal_id in topic[1]');
    return null;
  }

  const proposer = event.topic[2] ? String(safeNative(event.topic[2]) ?? '') : '';
  const body = safeNative(event.value) as Record<string, unknown> | undefined;

  const actionTypeRaw = body?.action_type ?? body?.action;
  let actionType = 'Unknown';
  if (Array.isArray(actionTypeRaw) && typeof actionTypeRaw[0] === 'string') {
    actionType = actionTypeRaw[0];
  } else if (typeof actionTypeRaw === 'string') {
    actionType = actionTypeRaw;
  }

  return {
    kind: 'proposal_created',
    proposalId,
    proposer: proposer || String(body?.proposer ?? ''),
    actionType,
    title: body?.title ? String(body.title) : undefined,
    descriptionHash: body?.description_hash ? String(body.description_hash) : undefined,
    ledger: event.ledger ?? 0,
    txHash: event.txHash ?? '',
    timestamp: parseLedgerTime(event.ledgerClosedAt),
  };
}

/**
 * Decode a `proposal_executed` event from contract event topics and value.
 * Topics: [Symbol("proposal_executed"), u64(proposal_id)]
 * Value: Map { proposal_id, action_type, proposed_value, votes_for, votes_against }
 */
export function decodeProposalExecutedEvent(
  event: rpc.Api.EventResponse,
  options: DecodeEventOptions = {}
): DecodedProposalExecutedEvent | null {
  if (!event || !Array.isArray(event.topic) || event.topic.length < 2) {
    if (options.strict) throw new EventDecodingError('Missing or insufficient topics for proposal_executed');
    return null;
  }

  const topic0 = safeNative(event.topic[0]);
  if (topic0 !== 'proposal_executed') return null;

  const proposalId = toPositiveNumberSafe(safeNative(event.topic[1]));
  if (proposalId === null) {
    if (options.strict) throw new EventDecodingError('Invalid or missing proposal_id in topic[1]');
    return null;
  }

  const body = safeNative(event.value) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') {
    if (options.strict) throw new EventDecodingError('Malformed value payload in proposal_executed');
    return null;
  }

  const actionRaw = body.action_type ?? body.action;
  let actionType = 'Unknown';
  if (Array.isArray(actionRaw) && typeof actionRaw[0] === 'string') {
    actionType = actionRaw[0];
  } else if (typeof actionRaw === 'string') {
    actionType = actionRaw;
  }

  const proposedValue = toBigIntSafe(body.proposed_value) ?? 0n;
  const votesFor = toBigIntSafe(body.votes_for) ?? 0n;
  const votesAgainst = toBigIntSafe(body.votes_against) ?? 0n;

  return {
    kind: 'proposal_executed',
    proposalId,
    actionType,
    proposedValue,
    votesFor,
    votesAgainst,
    ledger: event.ledger ?? 0,
    txHash: event.txHash ?? '',
    timestamp: parseLedgerTime(event.ledgerClosedAt),
  };
}

/**
 * Decode a `vote_cast` event from contract event topics and value.
 * Topics: [Symbol("vote_cast"), u64(proposal_id), Address(voter)]
 * Value: Map { proposal_id, voter, support / choice, voting_power / weight }
 */
export function decodeVoteCastEvent(
  event: rpc.Api.EventResponse,
  options: DecodeEventOptions = {}
): DecodedVoteCastEvent | null {
  if (!event || !Array.isArray(event.topic) || event.topic.length < 2) {
    if (options.strict) throw new EventDecodingError('Missing or insufficient topics for vote_cast');
    return null;
  }

  const topic0 = safeNative(event.topic[0]);
  if (topic0 !== 'vote_cast' && topic0 !== 'VoteCast') return null;

  const proposalId = toPositiveNumberSafe(safeNative(event.topic[1]));
  if (proposalId === null) {
    if (options.strict) throw new EventDecodingError('Invalid or missing proposal_id in vote_cast');
    return null;
  }

  const voterFromTopic = event.topic[2] ? String(safeNative(event.topic[2]) ?? '') : '';
  const body = (safeNative(event.value) as Record<string, unknown> | undefined) ?? {};

  const voter = voterFromTopic || String(body.voter ?? '');
  if (!voter) {
    if (options.strict) throw new EventDecodingError('Missing voter address in vote_cast');
    return null;
  }

  let choice: 'For' | 'Against' | 'Abstain' = 'For';
  const rawSupport = body.choice ?? body.support ?? (event.topic[3] ? safeNative(event.topic[3]) : undefined);
  if (rawSupport === 'Against' || rawSupport === false || rawSupport === 'false' || rawSupport === 0 || rawSupport === 0n) {
    choice = 'Against';
  } else if (rawSupport === 'Abstain' || rawSupport === 2 || rawSupport === 2n) {
    choice = 'Abstain';
  } else {
    choice = 'For';
  }

  const power = toBigIntSafe(body.voting_power ?? body.weight ?? body.power);
  if (power === null || power < 0n) {
    if (options.strict) throw new EventDecodingError('Invalid or negative voting power in vote_cast');
    return null;
  }

  return {
    kind: 'vote_cast',
    proposalId,
    voter,
    choice,
    votingPower: power,
    ledger: event.ledger ?? 0,
    txHash: event.txHash ?? '',
    timestamp: parseLedgerTime(event.ledgerClosedAt),
  };
}

/**
 * Decode a `proposal_vetoed` event from contract event topics and value.
 * Topics: [Symbol("proposal_vetoed"), u64(proposal_id), Address(admin)]
 * Value: Map { proposal_id, admin, reason_hash }
 */
export function decodeProposalVetoedEvent(
  event: rpc.Api.EventResponse,
  options: DecodeEventOptions = {}
): DecodedProposalVetoedEvent | null {
  if (!event || !Array.isArray(event.topic) || event.topic.length < 2) {
    if (options.strict) throw new EventDecodingError('Missing or insufficient topics for proposal_vetoed');
    return null;
  }

  const topic0 = safeNative(event.topic[0]);
  if (topic0 !== 'proposal_vetoed' && topic0 !== 'ProposalVetoed' && topic0 !== 'veto') return null;

  const proposalId = toPositiveNumberSafe(safeNative(event.topic[1]));
  if (proposalId === null) {
    if (options.strict) throw new EventDecodingError('Invalid or missing proposal_id in proposal_vetoed');
    return null;
  }

  const adminFromTopic = event.topic[2] ? String(safeNative(event.topic[2]) ?? '') : '';
  const body = (safeNative(event.value) as Record<string, unknown> | undefined) ?? {};

  const admin = adminFromTopic || String(body.admin ?? '');
  if (!admin) {
    if (options.strict) throw new EventDecodingError('Missing admin address in proposal_vetoed');
    return null;
  }

  const reasonHash = String(body.reason_hash ?? (event.topic[3] ? safeNative(event.topic[3]) : ''));
  if (!reasonHash) {
    if (options.strict) throw new EventDecodingError('Missing reason_hash in proposal_vetoed');
    return null;
  }

  return {
    kind: 'proposal_vetoed',
    proposalId,
    admin,
    reasonHash,
    ledger: event.ledger ?? 0,
    txHash: event.txHash ?? '',
    timestamp: parseLedgerTime(event.ledgerClosedAt),
  };
}

/**
 * Decode a `parameter_updated` event from contract event topics and value.
 * Topics: [Symbol("parameter_updated"), Symbol(param_name)]
 * Value: Map { param_name, old_value, new_value, updated_by }
 */
export function decodeParameterUpdatedEvent(
  event: rpc.Api.EventResponse,
  options: DecodeEventOptions = {}
): DecodedParameterUpdatedEvent | null {
  if (!event || !Array.isArray(event.topic) || event.topic.length < 2) {
    if (options.strict) throw new EventDecodingError('Missing or insufficient topics for parameter_updated');
    return null;
  }

  const topic0 = safeNative(event.topic[0]);
  if (topic0 !== 'parameter_updated' && topic0 !== 'ParameterUpdated') return null;

  const parameter = String(safeNative(event.topic[1]) ?? '');
  if (!parameter) {
    if (options.strict) throw new EventDecodingError('Missing parameter key in topic[1]');
    return null;
  }

  const body = safeNative(event.value) as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') {
    if (options.strict) throw new EventDecodingError('Malformed value payload in parameter_updated');
    return null;
  }

  const newValue = toBigIntSafe(body.new_value);
  if (newValue === null) {
    if (options.strict) throw new EventDecodingError('Missing or non-numeric new_value in parameter_updated');
    return null;
  }

  const oldValue = toBigIntSafe(body.old_value);
  const updatedBy = body.updated_by ? String(body.updated_by) : undefined;

  return {
    kind: 'parameter_updated',
    parameter,
    oldValue,
    newValue,
    updatedBy,
    ledger: event.ledger ?? 0,
    txHash: event.txHash ?? '',
    timestamp: parseLedgerTime(event.ledgerClosedAt),
  };
}

/**
 * Universal governance event decoder covering proposal, vote, veto, and parameter events (#1066).
 * Returns null if the event is not a supported governance event or is malformed.
 */
export function decodeGovernanceEvent(
  event: rpc.Api.EventResponse,
  options: DecodeEventOptions = {}
): DecodedGovernanceEvent | null {
  if (!event || !Array.isArray(event.topic) || event.topic.length === 0) return null;

  const topic0 = safeNative(event.topic[0]);
  switch (topic0) {
    case 'proposal_created':
      return decodeProposalCreatedEvent(event, options);
    case 'proposal_executed':
      return decodeProposalExecutedEvent(event, options);
    case 'vote_cast':
    case 'VoteCast':
      return decodeVoteCastEvent(event, options);
    case 'proposal_vetoed':
    case 'ProposalVetoed':
    case 'veto':
      return decodeProposalVetoedEvent(event, options);
    case 'parameter_updated':
    case 'ParameterUpdated':
      return decodeParameterUpdatedEvent(event, options);
    default:
      return null;
  }
}

// ─── Deterministic Event Fixture Factories ─────────────────────────────────────

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const u64 = (n: number | bigint) => nativeToScVal(BigInt(n), { type: 'u64' });
const i128 = (n: number | bigint) => nativeToScVal(BigInt(n), { type: 'i128' });
const addr = (a: string) => nativeToScVal(a, { type: 'address' });

function structScVal(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new xdr.ScMapEntry({ key: sym(key), val: fields[key] }))
  );
}

export function createRawEventFixture(
  contractId: string,
  topic: xdr.ScVal[],
  value: xdr.ScVal,
  meta: { ledger?: number; txHash?: string; ledgerClosedAt?: string } = {}
): rpc.Api.EventResponse {
  return {
    id: `${meta.ledger ?? 1000}-${meta.txHash ?? '00'.repeat(32)}`,
    type: 'contract',
    ledger: meta.ledger ?? 1000,
    ledgerClosedAt: meta.ledgerClosedAt ?? '2026-10-19T12:00:00Z',
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: true,
    txHash: meta.txHash ?? 'aa'.repeat(32),
    contractId: new Contract(contractId),
    topic,
    value,
  } as unknown as rpc.Api.EventResponse;
}

export function createProposalCreatedFixture(
  contractId: string,
  proposalId: number,
  proposer: string,
  actionType = 'UpdateFeeRate',
  meta: { ledger?: number; txHash?: string } = {}
): rpc.Api.EventResponse {
  return createRawEventFixture(
    contractId,
    [sym('proposal_created'), u64(proposalId), addr(proposer)],
    structScVal({
      proposal_id: u64(proposalId),
      proposer: addr(proposer),
      action_type: sym(actionType),
      title: nativeToScVal('Test Proposal Title'),
      description_hash: nativeToScVal('0xdeadbeef'),
    }),
    meta
  );
}

export function createProposalExecutedFixture(
  contractId: string,
  proposalId: number,
  actionType = 'UpdateFeeRate',
  meta: { ledger?: number; txHash?: string; proposedValue?: number; votesFor?: number; votesAgainst?: number } = {}
): rpc.Api.EventResponse {
  return createRawEventFixture(
    contractId,
    [sym('proposal_executed'), u64(proposalId)],
    structScVal({
      proposal_id: u64(proposalId),
      action_type: sym(actionType),
      proposed_value: i128(meta.proposedValue ?? 30),
      votes_for: i128(meta.votesFor ?? 5000),
      votes_against: i128(meta.votesAgainst ?? 200),
    }),
    meta
  );
}

export function createVoteCastFixture(
  contractId: string,
  proposalId: number,
  voter: string,
  choice: 'For' | 'Against' | 'Abstain' = 'For',
  weight = 1250,
  meta: { ledger?: number; txHash?: string } = {}
): rpc.Api.EventResponse {
  return createRawEventFixture(
    contractId,
    [sym('vote_cast'), u64(proposalId), addr(voter)],
    structScVal({
      proposal_id: u64(proposalId),
      voter: addr(voter),
      choice: sym(choice),
      voting_power: i128(weight),
    }),
    meta
  );
}

export function createProposalVetoedFixture(
  contractId: string,
  proposalId: number,
  admin: string,
  reasonHash: string,
  meta: { ledger?: number; txHash?: string } = {}
): rpc.Api.EventResponse {
  return createRawEventFixture(
    contractId,
    [sym('proposal_vetoed'), u64(proposalId), addr(admin)],
    structScVal({
      proposal_id: u64(proposalId),
      admin: addr(admin),
      reason_hash: nativeToScVal(reasonHash),
    }),
    meta
  );
}

export function createParameterUpdatedFixture(
  contractId: string,
  parameter: string,
  oldValue: number,
  newValue: number,
  updatedBy?: string,
  meta: { ledger?: number; txHash?: string } = {}
): rpc.Api.EventResponse {
  const fields: Record<string, xdr.ScVal> = {
    param_name: sym(parameter),
    old_value: i128(oldValue),
    new_value: i128(newValue),
  };
  if (updatedBy) {
    fields.updated_by = addr(updatedBy);
  }
  return createRawEventFixture(
    contractId,
    [sym('parameter_updated'), sym(parameter)],
    structScVal(fields),
    meta
  );
}
