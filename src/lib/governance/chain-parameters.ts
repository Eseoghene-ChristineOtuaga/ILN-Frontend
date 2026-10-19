/**
 * Proposal-validation parameters derived from current authority data (#1054).
 *
 * Every value here comes from a contract read or a confirmed contract event.
 * A failed authoritative read is an explicit error, never a hard-coded default:
 *
 *   iln_governance.get_min_proposal_balance()   -> i128  (proposer holding gate)
 *   iln_governance.get_min_proposal_deposit()   -> i128  (escrowed anti-spam deposit)
 *   iln_governance.get_min_quorum_bps()         -> u32
 *   iln_governance.get_gov_token_total_supply() -> i128
 *   <ILN token>.decimals()                      -> u32
 *   invoice_liquidity.get_token_decimals(addr)  -> accepted-token allowlist
 *
 * The invoice contract does not expose a read for its current flat fee rate or
 * maximum discount rate. Those are taken from the latest confirmed
 * `parameter_updated` event (#1057) and are `null` — reported as unknown — when
 * no change falls inside RPC event retention.
 */

import {
  BPS_DENOMINATOR,
  INVOICE_MAX_DISCOUNT_RATE_BPS,
  type BpsRange,
  type ProposalValidationContext,
} from './contract-schema';
import { latestParameterValues, type ParameterUpdateEvent } from './parameter-events';

export interface AcceptedToken {
  address: string;
  name: string;
  symbol: string;
  decimals?: number;
}

export interface ProtocolParameters {
  /** Current protocol fee rate in bps, or `null` when not confirmable on-chain. */
  feeRateBps: number | null;
  /** Current maximum discount rate in bps, or `null` when not confirmable on-chain. */
  maxDiscountRateBps: number | null;
  /** Tokens currently accepted by the invoice contract. */
  acceptedTokens: AcceptedToken[];
  /** Minimum governance-token balance to propose, in token base units. */
  minProposalBalance: bigint;
  /** Deposit escrowed at proposal creation, in token base units. */
  minProposalDeposit: bigint;
  /** Minimum ILN balance required to submit a proposal, in whole tokens (display). */
  minProposalILN: number;
  /** Minimum quorum threshold in basis points. */
  quorumThresholdBps: number;
  /** Governance token total supply recorded by the governance contract, in base units. */
  govTokenTotalSupply: bigint;
  /** Decimals of the governance (ILN) token. */
  govTokenDecimals: number;
  /** Accepted ranges for proposed rate values. */
  feeRateRange: BpsRange;
  maxDiscountRateRange: BpsRange;
  /** Parameters that could not be confirmed and are reported as unknown. */
  unconfirmed: Array<'feeRateBps' | 'maxDiscountRateBps'>;
}

export type ChainParameterName =
  | 'minProposalBalance'
  | 'minProposalDeposit'
  | 'quorumThresholdBps'
  | 'govTokenTotalSupply'
  | 'govTokenDecimals'
  | 'acceptedTokens';

export class ChainParametersError extends Error {
  readonly code = 'CHAIN_PARAMETERS_UNAVAILABLE';

  constructor(
    readonly failed: ChainParameterName[],
    options?: { cause?: unknown }
  ) {
    super(
      `CHAIN_PARAMETERS_UNAVAILABLE: Could not read ${failed.join(', ')} from the network.`,
      options
    );
    this.name = 'ChainParametersError';
  }
}

export const FEE_RATE_RANGE: BpsRange = Object.freeze({ min: 0, max: BPS_DENOMINATOR });
// `submit_invoice` rejects a discount of 0, so a 0% maximum would block every invoice.
export const MAX_DISCOUNT_RATE_RANGE: BpsRange = Object.freeze({
  min: 1,
  max: INVOICE_MAX_DISCOUNT_RATE_BPS,
});

export interface ChainParameterReaders {
  governanceContractId: string;
  govTokenContractId: string;
  /** Simulate a read-only call and return its decoded return value. */
  readContract: (contractId: string, method: string) => Promise<unknown>;
  /** Accepted tokens of the invoice contract. */
  getAcceptedTokens: () => Promise<AcceptedToken[]>;
  /** Confirmed parameter changes, newest first. May throw; values then become unknown. */
  getParameterUpdates: () => Promise<ParameterUpdateEvent[]>;
}

function toBigInt(value: unknown, name: ChainParameterName): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new TypeError(`${name} is not an integer`);
}

function toSafeNumber(value: unknown, name: ChainParameterName): number {
  const big = toBigInt(value, name);
  if (big < 0n || big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`${name} is out of range`);
  }
  return Number(big);
}

/** Whole-token display value of a base-unit amount, rounded up so the gate is never understated. */
export function baseUnitsToTokens(amount: bigint, decimals: number): number {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale + (amount % scale === 0n ? 0n : 1n);
  return Number(whole);
}

/**
 * The balance a proposer needs: the holding gate, and at least the deposit
 * that will be escrowed (mirrors the two checks in `create_proposal`).
 */
export function requiredProposerBalance(params: ProtocolParameters): bigint {
  return params.minProposalDeposit > params.minProposalBalance
    ? params.minProposalDeposit
    : params.minProposalBalance;
}

/** Quorum in governance-token base units: `totalSupply * quorumBps / 10_000`. */
export function quorumThresholdTokens(params: ProtocolParameters): bigint {
  return (params.govTokenTotalSupply * BigInt(params.quorumThresholdBps)) / BigInt(BPS_DENOMINATOR);
}

export async function fetchChainParameters(
  readers: ChainParameterReaders
): Promise<ProtocolParameters> {
  const read = (contractId: string, method: string) => readers.readContract(contractId, method);

  const results = await Promise.allSettled([
    read(readers.governanceContractId, 'get_min_proposal_balance'),
    read(readers.governanceContractId, 'get_min_proposal_deposit'),
    read(readers.governanceContractId, 'get_min_quorum_bps'),
    read(readers.governanceContractId, 'get_gov_token_total_supply'),
    read(readers.govTokenContractId, 'decimals'),
    readers.getAcceptedTokens(),
  ]);
  const names: ChainParameterName[] = [
    'minProposalBalance',
    'minProposalDeposit',
    'quorumThresholdBps',
    'govTokenTotalSupply',
    'govTokenDecimals',
    'acceptedTokens',
  ];

  const failed: ChainParameterName[] = [];
  const values: unknown[] = results.map((result, index) => {
    if (result.status === 'rejected') {
      failed.push(names[index]);
      return undefined;
    }
    return result.value;
  });

  let parsed: Omit<
    ProtocolParameters,
    'feeRateBps' | 'maxDiscountRateBps' | 'unconfirmed' | 'minProposalILN'
  >;
  try {
    if (failed.length > 0) throw new Error('reads failed');
    const govTokenDecimals = toSafeNumber(values[4], 'govTokenDecimals');
    const quorumThresholdBps = toSafeNumber(values[2], 'quorumThresholdBps');
    if (quorumThresholdBps < 1 || quorumThresholdBps > BPS_DENOMINATOR) {
      throw new RangeError('quorumThresholdBps is out of range');
    }
    parsed = {
      minProposalBalance: toBigInt(values[0], 'minProposalBalance'),
      minProposalDeposit: toBigInt(values[1], 'minProposalDeposit'),
      quorumThresholdBps,
      govTokenTotalSupply: toBigInt(values[3], 'govTokenTotalSupply'),
      govTokenDecimals,
      acceptedTokens: values[5] as AcceptedToken[],
      feeRateRange: FEE_RATE_RANGE,
      maxDiscountRateRange: MAX_DISCOUNT_RATE_RANGE,
    };
  } catch (error) {
    throw new ChainParametersError(failed.length > 0 ? failed : names.slice(0, 5), {
      cause: error,
    });
  }

  // Current rates: confirmed events only. An events outage leaves them unknown.
  let latest = new Map<string, bigint>();
  try {
    latest = latestParameterValues(await readers.getParameterUpdates());
  } catch {
    latest = new Map();
  }
  const fee = latest.get('protocol_fee_rate_bps');
  const discount = latest.get('max_discount_rate_bps');
  const feeRateBps = fee === undefined ? null : Number(fee);
  const maxDiscountRateBps = discount === undefined ? null : Number(discount);
  const unconfirmed: ProtocolParameters['unconfirmed'] = [];
  if (feeRateBps === null) unconfirmed.push('feeRateBps');
  if (maxDiscountRateBps === null) unconfirmed.push('maxDiscountRateBps');

  const result: ProtocolParameters = {
    ...parsed,
    feeRateBps,
    maxDiscountRateBps,
    unconfirmed,
    minProposalILN: 0,
  };
  result.minProposalILN = baseUnitsToTokens(
    requiredProposerBalance(result),
    result.govTokenDecimals
  );
  return result;
}

/** Narrow chain parameters to what the payload schema needs. */
export function toValidationContext(params: ProtocolParameters): ProposalValidationContext {
  return {
    feeRateRange: params.feeRateRange,
    maxDiscountRateRange: params.maxDiscountRateRange,
    currentFeeRateBps: params.feeRateBps,
    currentMaxDiscountRateBps: params.maxDiscountRateBps,
    acceptedTokenAddresses: params.acceptedTokens.map((token) => token.address),
  };
}
