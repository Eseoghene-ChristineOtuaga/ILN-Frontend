/**
 * Governance proposal payload schema (#1056).
 *
 * Mirrors the deployed `iln_governance` contract so malformed proposals are
 * rejected in the browser, before any simulation, signature or fee:
 *
 *   create_proposal(
 *     proposer: Address,
 *     action_type: ProposalAction,
 *     description_hash: BytesN<32>,
 *     proposed_value: i128,
 *   ) -> u64
 *
 * `ProposalAction` (contracttype enum, tuple variants) for the four actions the
 * creation form exposes:
 *
 *   UpdateFeeRate(u32)            -> invoice_liquidity.update_fee_rate(rate)
 *   UpdateMaxDiscountRate(u32)    -> invoice_liquidity.update_max_discount(rate)
 *   AddToken(Address, u32)        -> invoice_liquidity.add_token(token, decimals)
 *   RemoveToken(Address)          -> invoice_liquidity.remove_token(token)
 *
 * Title and description are not stored on-chain: the contract keeps only a
 * 32-byte `description_hash`, computed here from the canonical text so the
 * same proposal text always yields the same hash.
 *
 * Source: Invoice-Liquidity-Network/ILN-Smart-Contract
 *   contracts/iln_governance/src/lib.rs (ProposalAction, create_proposal)
 *   contracts/invoice_liquidity/src/constants.rs (MAX_DISCOUNT_RATE)
 */

import { Address, StrKey, nativeToScVal, xdr } from '@stellar/stellar-sdk';

// ─── Contract-derived bounds ──────────────────────────────────────────────────

/** Rates are basis points of a whole: 10_000 bps = 100%. */
export const BPS_DENOMINATOR = 10_000;

/**
 * `invoice_liquidity::constants::MAX_DISCOUNT_RATE`. `submit_invoice` rejects a
 * discount rate above this, so a higher protocol-wide maximum would be inert.
 */
export const INVOICE_MAX_DISCOUNT_RATE_BPS = 5_000;

/** Upper bound for a Soroban `u32` argument. */
export const U32_MAX = 4_294_967_295;

/**
 * SEP-41 / SAC token decimals the invoice contract will accept. The contract
 * checks the declared value against the token's own `decimals()`; this bound
 * just rejects nonsense before simulation.
 */
export const MAX_TOKEN_DECIMALS = 38;

/** Proposal text limits. Text is hashed, so these protect UX and wallet display. */
export const PROPOSAL_TITLE_MAX_LENGTH = 120;
export const PROPOSAL_DESCRIPTION_MAX_LENGTH = 10_000;
export const PROPOSAL_DESCRIPTION_MIN_LENGTH = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

/** The four form-level proposal types exposed in the creation UI. */
export type CreateProposalFormType = 'FeeRate' | 'AddToken' | 'RemoveToken' | 'MaxDiscountRate';

export interface CreateProposalPayload {
  formType: CreateProposalFormType;
  title: string;
  description: string;
  /** New basis-point value for FeeRate / MaxDiscountRate proposals. */
  newValueBps?: number;
  /** Token contract address for AddToken proposals. */
  tokenAddress?: string;
  /** Resolved token symbol (AddToken, display only). */
  tokenName?: string;
  /** Token decimals resolved from the token contract (AddToken). */
  tokenDecimals?: number;
  /** Token address to remove (RemoveToken). */
  removeTokenAddress?: string;
}

/** Inclusive basis-point range. */
export interface BpsRange {
  min: number;
  max: number;
}

/**
 * Chain-derived facts the schema needs (#1054). Values that the chain cannot
 * currently provide are `null`, and checks that depend on them are skipped
 * rather than compared against an invented default.
 */
export interface ProposalValidationContext {
  feeRateRange: BpsRange;
  maxDiscountRateRange: BpsRange;
  /** Current on-chain fee rate, when known. */
  currentFeeRateBps: number | null;
  /** Current on-chain max discount rate, when known. */
  currentMaxDiscountRateBps: number | null;
  /** Token contract addresses currently accepted by the invoice contract. */
  acceptedTokenAddresses: readonly string[];
}

export type ProposalAction =
  | { kind: 'UpdateFeeRate'; rateBps: number }
  | { kind: 'UpdateMaxDiscountRate'; rateBps: number }
  | { kind: 'AddToken'; token: string; decimals: number }
  | { kind: 'RemoveToken'; token: string };

export interface ValidatedProposal {
  action: ProposalAction;
  title: string;
  description: string;
  /** `proposed_value` argument: the new rate, or 0 for token actions. */
  proposedValue: bigint;
}

export type ProposalField =
  | 'formType'
  | 'title'
  | 'description'
  | 'newValueBps'
  | 'tokenAddress'
  | 'removeTokenAddress';

export type ProposalValidationCode =
  | 'REQUIRED'
  | 'TOO_LONG'
  | 'TOO_SHORT'
  | 'INVALID_CHARACTERS'
  | 'NOT_AN_INTEGER'
  | 'OUT_OF_RANGE'
  | 'UNCHANGED'
  | 'INVALID_CONTRACT_ADDRESS'
  | 'ALREADY_ACCEPTED'
  | 'NOT_ACCEPTED'
  | 'DECIMALS_UNRESOLVED'
  | 'UNSUPPORTED_ACTION';

export interface ProposalValidationIssue {
  field: ProposalField;
  code: ProposalValidationCode;
  message: string;
}

export type ProposalValidationResult =
  | { ok: true; proposal: ValidatedProposal }
  | { ok: false; issues: ProposalValidationIssue[] };

/** Thrown by write paths that receive a payload failing {@link validateProposalPayload}. */
export class ProposalValidationError extends Error {
  readonly code = 'PROPOSAL_VALIDATION_FAILED';

  constructor(readonly issues: ProposalValidationIssue[]) {
    super(
      `PROPOSAL_VALIDATION_FAILED: ${issues.map((issue) => `${issue.field}: ${issue.message}`).join('; ')}`
    );
    this.name = 'ProposalValidationError';
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

// C0 controls other than tab/newline/carriage return, DEL, and Unicode
// bidirectional overrides (which can make a title display differently from
// what the hash commits to).
const FORBIDDEN_TEXT_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F‪-‮⁦-⁩]/;
const FORBIDDEN_TITLE_CHARS = /[\r\n\t]/;

function validateText(
  value: string,
  field: 'title' | 'description',
  { min, max, singleLine }: { min: number; max: number; singleLine: boolean },
  issues: ProposalValidationIssue[]
): string {
  const text = typeof value === 'string' ? value.normalize('NFC').trim() : '';
  const label = field === 'title' ? 'Title' : 'Description';
  if (text.length === 0) {
    issues.push({ field, code: 'REQUIRED', message: `${label} is required.` });
  } else if (text.length < min) {
    issues.push({
      field,
      code: 'TOO_SHORT',
      message: `${label} must be at least ${min} characters.`,
    });
  } else if (text.length > max) {
    issues.push({
      field,
      code: 'TOO_LONG',
      message: `${label} must be at most ${max} characters.`,
    });
  } else if (FORBIDDEN_TEXT_CHARS.test(text) || (singleLine && FORBIDDEN_TITLE_CHARS.test(text))) {
    issues.push({
      field,
      code: 'INVALID_CHARACTERS',
      message: `${label} contains control or direction-override characters.`,
    });
  }
  return text;
}

function validateRate(
  value: number | undefined,
  range: BpsRange,
  current: number | null,
  label: string,
  issues: ProposalValidationIssue[]
): number | undefined {
  if (value === undefined || value === null || Number.isNaN(value)) {
    issues.push({ field: 'newValueBps', code: 'REQUIRED', message: 'Proposed value is required.' });
    return undefined;
  }
  if (!Number.isInteger(value)) {
    issues.push({
      field: 'newValueBps',
      code: 'NOT_AN_INTEGER',
      message: 'Proposed value must be a whole number of basis points.',
    });
    return undefined;
  }
  if (value < range.min || value > range.max) {
    issues.push({
      field: 'newValueBps',
      code: 'OUT_OF_RANGE',
      message: `${label} must be between ${range.min} and ${range.max} basis points.`,
    });
    return undefined;
  }
  if (current !== null && value === current) {
    issues.push({
      field: 'newValueBps',
      code: 'UNCHANGED',
      message: `${label} is already ${current} basis points.`,
    });
    return undefined;
  }
  return value;
}

/** True for a well-formed Soroban contract ID (`C…`, valid checksum). */
export function isContractAddress(address: string): boolean {
  return typeof address === 'string' && StrKey.isValidContract(address.trim());
}

/**
 * Validate a creation-form payload against the contract schema and current
 * chain parameters. Pure: performs no I/O and never throws.
 */
export function validateProposalPayload(
  payload: CreateProposalPayload,
  context: ProposalValidationContext
): ProposalValidationResult {
  const issues: ProposalValidationIssue[] = [];

  const title = validateText(
    payload.title,
    'title',
    { min: 1, max: PROPOSAL_TITLE_MAX_LENGTH, singleLine: true },
    issues
  );
  const description = validateText(
    payload.description,
    'description',
    {
      min: PROPOSAL_DESCRIPTION_MIN_LENGTH,
      max: PROPOSAL_DESCRIPTION_MAX_LENGTH,
      singleLine: false,
    },
    issues
  );

  const accepted = new Set(context.acceptedTokenAddresses.map((a) => a.trim()));
  let action: ProposalAction | undefined;

  switch (payload.formType) {
    case 'FeeRate': {
      const rate = validateRate(
        payload.newValueBps,
        context.feeRateRange,
        context.currentFeeRateBps,
        'Fee rate',
        issues
      );
      if (rate !== undefined) action = { kind: 'UpdateFeeRate', rateBps: rate };
      break;
    }
    case 'MaxDiscountRate': {
      const rate = validateRate(
        payload.newValueBps,
        context.maxDiscountRateRange,
        context.currentMaxDiscountRateBps,
        'Maximum discount rate',
        issues
      );
      if (rate !== undefined) action = { kind: 'UpdateMaxDiscountRate', rateBps: rate };
      break;
    }
    case 'AddToken': {
      const token = (payload.tokenAddress ?? '').trim();
      if (!token) {
        issues.push({
          field: 'tokenAddress',
          code: 'REQUIRED',
          message: 'Token address is required.',
        });
      } else if (!isContractAddress(token)) {
        issues.push({
          field: 'tokenAddress',
          code: 'INVALID_CONTRACT_ADDRESS',
          message: 'Token must be a Soroban token contract address (C…).',
        });
      } else if (accepted.has(token)) {
        issues.push({
          field: 'tokenAddress',
          code: 'ALREADY_ACCEPTED',
          message: 'This token is already accepted by the protocol.',
        });
      } else if (
        payload.tokenDecimals === undefined ||
        !Number.isInteger(payload.tokenDecimals) ||
        payload.tokenDecimals < 0 ||
        payload.tokenDecimals > MAX_TOKEN_DECIMALS
      ) {
        issues.push({
          field: 'tokenAddress',
          code: 'DECIMALS_UNRESOLVED',
          message: "The token's decimals could not be read from its contract.",
        });
      } else {
        action = { kind: 'AddToken', token, decimals: payload.tokenDecimals };
      }
      break;
    }
    case 'RemoveToken': {
      const token = (payload.removeTokenAddress ?? '').trim();
      if (!token) {
        issues.push({
          field: 'removeTokenAddress',
          code: 'REQUIRED',
          message: 'Select a token to remove.',
        });
      } else if (!isContractAddress(token)) {
        issues.push({
          field: 'removeTokenAddress',
          code: 'INVALID_CONTRACT_ADDRESS',
          message: 'Token must be a Soroban token contract address (C…).',
        });
      } else if (!accepted.has(token)) {
        issues.push({
          field: 'removeTokenAddress',
          code: 'NOT_ACCEPTED',
          message: 'This token is not currently accepted by the protocol.',
        });
      } else {
        action = { kind: 'RemoveToken', token };
      }
      break;
    }
    default:
      issues.push({
        field: 'formType',
        code: 'UNSUPPORTED_ACTION',
        message: 'Choose a supported proposal action.',
      });
  }

  if (issues.length > 0 || !action) {
    return { ok: false, issues };
  }

  const proposedValue =
    action.kind === 'UpdateFeeRate' || action.kind === 'UpdateMaxDiscountRate'
      ? BigInt(action.rateBps)
      : 0n;

  return { ok: true, proposal: { action, title, description, proposedValue } };
}

/** Field → first message map, for form rendering. */
export function issuesByField(
  issues: ProposalValidationIssue[]
): Partial<Record<ProposalField, string>> {
  const byField: Partial<Record<ProposalField, string>> = {};
  for (const issue of issues) {
    byField[issue.field] ??= issue.message;
  }
  return byField;
}

// ─── Contract encoding ────────────────────────────────────────────────────────

function u32(value: number): xdr.ScVal {
  if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
    throw new RangeError(`Value ${value} does not fit in a u32.`);
  }
  return nativeToScVal(value, { type: 'u32' });
}

/**
 * Encode a `ProposalAction` the way Soroban encodes a `#[contracttype]` enum
 * with tuple variants: `Vec[Symbol(variant), ...fields]`.
 */
export function encodeProposalAction(action: ProposalAction): xdr.ScVal {
  switch (action.kind) {
    case 'UpdateFeeRate':
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('UpdateFeeRate'), u32(action.rateBps)]);
    case 'UpdateMaxDiscountRate':
      return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol('UpdateMaxDiscountRate'), u32(action.rateBps)]);
    case 'AddToken':
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('AddToken'),
        Address.fromString(action.token).toScVal(),
        u32(action.decimals),
      ]);
    case 'RemoveToken':
      return xdr.ScVal.scvVec([
        xdr.ScVal.scvSymbol('RemoveToken'),
        Address.fromString(action.token).toScVal(),
      ]);
  }
}

/**
 * Canonical bytes committed to by `description_hash`: a versioned JSON
 * document with sorted keys, so any client can recompute the hash from the
 * published title and description.
 */
export function canonicalProposalText(title: string, description: string): string {
  return JSON.stringify({ description, title, v: 1 });
}

/** SHA-256 of {@link canonicalProposalText} — the `description_hash: BytesN<32>` argument. */
export async function proposalDescriptionHash(
  title: string,
  description: string
): Promise<Uint8Array> {
  const bytes = new TextEncoder().encode(canonicalProposalText(title, description));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return new Uint8Array(digest);
}

/** Hex form of the description hash, for display and off-chain publication. */
export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Full `create_proposal` argument list, in contract order. */
export async function encodeCreateProposalArgs(
  proposer: string,
  proposal: ValidatedProposal
): Promise<xdr.ScVal[]> {
  const hash = await proposalDescriptionHash(proposal.title, proposal.description);
  return [
    Address.fromString(proposer).toScVal(),
    encodeProposalAction(proposal.action),
    xdr.ScVal.scvBytes(Buffer.from(hash)),
    nativeToScVal(proposal.proposedValue, { type: 'i128' }),
  ];
}
