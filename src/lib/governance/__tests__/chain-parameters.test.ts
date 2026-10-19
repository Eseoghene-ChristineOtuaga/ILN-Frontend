/**
 * Proposal validation uses current chain parameters (#1054); a failed
 * authoritative read is an explicit error, never a hard-coded default.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ChainParametersError,
  baseUnitsToTokens,
  fetchChainParameters,
  quorumThresholdTokens,
  requiredProposerBalance,
  toValidationContext,
  type ChainParameterReaders,
} from '../chain-parameters';
import type { ParameterUpdateEvent } from '../parameter-events';

const GOV = 'CGOV';
const ILN = 'CILN';
const USDC = { address: 'CUSDC', name: 'USD Coin', symbol: 'USDC', decimals: 7 };

const reads: Record<string, unknown> = {
  [`${GOV}.get_min_proposal_balance`]: 1_000_0000000n,
  [`${GOV}.get_min_proposal_deposit`]: 250_0000000n,
  [`${GOV}.get_min_quorum_bps`]: 1_000,
  [`${GOV}.get_gov_token_total_supply`]: 1_000_000_0000000n,
  [`${ILN}.decimals`]: 7,
};

function readers(overrides: Partial<ChainParameterReaders> = {}): ChainParameterReaders {
  return {
    governanceContractId: GOV,
    govTokenContractId: ILN,
    readContract: vi.fn(async (id: string, method: string) => {
      const key = `${id}.${method}`;
      if (!(key in reads)) throw new Error(`no ${key}`);
      return reads[key];
    }),
    getAcceptedTokens: vi.fn(async () => [USDC]),
    getParameterUpdates: vi.fn(async () => [] as ParameterUpdateEvent[]),
    ...overrides,
  };
}

const update = (parameter: string, value: bigint) =>
  ({ parameter, rawNewValue: value }) as ParameterUpdateEvent;

describe('fetchChainParameters', () => {
  it('reads every gate from the contracts', async () => {
    const r = readers({
      getParameterUpdates: vi.fn(async () => [
        update('protocol_fee_rate_bps', 25n),
        update('protocol_fee_rate_bps', 30n),
        update('max_discount_rate_bps', 450n),
      ]),
    });
    const params = await fetchChainParameters(r);

    expect(params).toMatchObject({
      feeRateBps: 25,
      maxDiscountRateBps: 450,
      acceptedTokens: [USDC],
      minProposalBalance: 1_000_0000000n,
      minProposalDeposit: 250_0000000n,
      minProposalILN: 1_000,
      quorumThresholdBps: 1_000,
      govTokenTotalSupply: 1_000_000_0000000n,
      govTokenDecimals: 7,
      feeRateRange: { min: 0, max: 10_000 },
      maxDiscountRateRange: { min: 1, max: 5_000 },
      unconfirmed: [],
    });
    expect(r.readContract).toHaveBeenCalledWith(GOV, 'get_min_proposal_balance');
    expect(r.readContract).toHaveBeenCalledWith(ILN, 'decimals');
  });

  it('reports current rates as unknown when no confirmed change is available', async () => {
    const params = await fetchChainParameters(
      readers({ getParameterUpdates: vi.fn().mockRejectedValue(new Error('rpc down')) })
    );
    expect(params.feeRateBps).toBeNull();
    expect(params.maxDiscountRateBps).toBeNull();
    expect(params.unconfirmed).toEqual(['feeRateBps', 'maxDiscountRateBps']);
  });

  it('throws ChainParametersError naming the reads that failed', async () => {
    const r = readers({
      getAcceptedTokens: vi.fn().mockRejectedValue(new Error('offline')),
      readContract: vi.fn(async (id: string, method: string) => {
        if (method === 'get_min_quorum_bps') throw new Error('offline');
        return reads[`${id}.${method}`];
      }),
    });
    const error = await fetchChainParameters(r).catch((e) => e);
    expect(error).toBeInstanceOf(ChainParametersError);
    expect(error.code).toBe('CHAIN_PARAMETERS_UNAVAILABLE');
    expect(error.failed).toEqual(['quorumThresholdBps', 'acceptedTokens']);
  });

  it('rejects malformed contract values rather than coercing them', async () => {
    const r = readers({
      readContract: vi.fn(async (id: string, method: string) =>
        method === 'get_min_quorum_bps' ? 20_000 : reads[`${id}.${method}`]
      ),
    });
    await expect(fetchChainParameters(r)).rejects.toBeInstanceOf(ChainParametersError);
  });
});

describe('derived values', () => {
  it('requires the larger of the holding gate and the deposit', async () => {
    const params = await fetchChainParameters(readers());
    expect(requiredProposerBalance(params)).toBe(1_000_0000000n);
    expect(requiredProposerBalance({ ...params, minProposalDeposit: 2_000_0000000n })).toBe(
      2_000_0000000n
    );
  });

  it('rounds the displayed token gate up', () => {
    expect(baseUnitsToTokens(10_0000000n, 7)).toBe(10);
    expect(baseUnitsToTokens(10_0000001n, 7)).toBe(11);
  });

  it('computes quorum from supply and bps', async () => {
    const params = await fetchChainParameters(readers());
    expect(quorumThresholdTokens(params)).toBe(100_000_0000000n);
  });

  it('narrows to a validation context', async () => {
    const params = await fetchChainParameters(readers());
    expect(toValidationContext(params)).toEqual({
      feeRateRange: { min: 0, max: 10_000 },
      maxDiscountRateRange: { min: 1, max: 5_000 },
      currentFeeRateBps: null,
      currentMaxDiscountRateBps: null,
      acceptedTokenAddresses: ['CUSDC'],
    });
  });
});
