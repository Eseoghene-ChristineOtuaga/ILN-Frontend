/**
 * Proposal payload schema (#1056): every payload the creation form can send is
 * checked against the deployed `iln_governance` types before simulation.
 */
import { describe, expect, it } from 'vitest';
import { Address, scValToNative, xdr } from '@stellar/stellar-sdk';
import {
  canonicalProposalText,
  encodeCreateProposalArgs,
  encodeProposalAction,
  issuesByField,
  proposalDescriptionHash,
  toHex,
  validateProposalPayload,
  type CreateProposalPayload,
  type ProposalValidationContext,
} from '../contract-schema';

const USDC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
const XLM_SAC = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const PROPOSER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const context: ProposalValidationContext = {
  feeRateRange: { min: 0, max: 10_000 },
  maxDiscountRateRange: { min: 1, max: 5_000 },
  currentFeeRateBps: 30,
  currentMaxDiscountRateBps: null,
  acceptedTokenAddresses: [USDC],
};

const base = {
  title: 'Lower the protocol fee',
  description: 'Reduce the protocol fee to stay competitive with other pools.',
};

function codes(payload: CreateProposalPayload, ctx = context) {
  const result = validateProposalPayload(payload, ctx);
  return result.ok ? [] : result.issues.map((i) => `${i.field}:${i.code}`);
}

describe('validateProposalPayload – text', () => {
  it('requires a title and a description of at least 20 characters', () => {
    expect(
      codes({ formType: 'FeeRate', newValueBps: 20, title: ' ', description: 'short' })
    ).toEqual(['title:REQUIRED', 'description:TOO_SHORT']);
  });

  it('rejects over-long text', () => {
    expect(
      codes({ ...base, formType: 'FeeRate', newValueBps: 20, title: 'x'.repeat(121) })
    ).toEqual(['title:TOO_LONG']);
  });

  it('rejects control characters, newlines in titles and bidi overrides', () => {
    expect(codes({ ...base, formType: 'FeeRate', newValueBps: 20, title: 'a\nb' })).toEqual([
      'title:INVALID_CHARACTERS',
    ]);
    expect(
      codes({ ...base, formType: 'FeeRate', newValueBps: 20, description: `${base.description}‮` })
    ).toEqual(['description:INVALID_CHARACTERS']);
  });

  it('NFC-normalises and trims the committed text', () => {
    const result = validateProposalPayload(
      { ...base, formType: 'FeeRate', newValueBps: 20, title: '  Café fee  ' },
      context
    );
    expect(result.ok && result.proposal.title).toBe('Café fee');
  });
});

describe('validateProposalPayload – rates', () => {
  it('accepts an in-range change and encodes the proposed value', () => {
    const result = validateProposalPayload(
      { ...base, formType: 'FeeRate', newValueBps: 20 },
      context
    );
    expect(result).toEqual({
      ok: true,
      proposal: {
        action: { kind: 'UpdateFeeRate', rateBps: 20 },
        title: base.title,
        description: base.description,
        proposedValue: 20n,
      },
    });
  });

  it('uses the chain range, not a hard-coded 0–5000', () => {
    expect(codes({ ...base, formType: 'FeeRate', newValueBps: 6_000 })).toEqual([]);
    expect(codes({ ...base, formType: 'FeeRate', newValueBps: 10_001 })).toEqual([
      'newValueBps:OUT_OF_RANGE',
    ]);
    expect(codes({ ...base, formType: 'MaxDiscountRate', newValueBps: 0 })).toEqual([
      'newValueBps:OUT_OF_RANGE',
    ]);
    expect(codes({ ...base, formType: 'MaxDiscountRate', newValueBps: 5_001 })).toEqual([
      'newValueBps:OUT_OF_RANGE',
    ]);
  });

  it('rejects missing and fractional values', () => {
    expect(codes({ ...base, formType: 'FeeRate' })).toEqual(['newValueBps:REQUIRED']);
    expect(codes({ ...base, formType: 'FeeRate', newValueBps: NaN })).toEqual([
      'newValueBps:REQUIRED',
    ]);
    expect(codes({ ...base, formType: 'FeeRate', newValueBps: 12.5 })).toEqual([
      'newValueBps:NOT_AN_INTEGER',
    ]);
  });

  it('rejects a no-op only when the current value is confirmed', () => {
    expect(codes({ ...base, formType: 'FeeRate', newValueBps: 30 })).toEqual([
      'newValueBps:UNCHANGED',
    ]);
    // currentMaxDiscountRateBps is unknown, so no value is treated as unchanged.
    expect(codes({ ...base, formType: 'MaxDiscountRate', newValueBps: 500 })).toEqual([]);
  });
});

describe('validateProposalPayload – tokens', () => {
  it('requires a Soroban contract address for AddToken', () => {
    expect(
      codes({ ...base, formType: 'AddToken', tokenAddress: PROPOSER, tokenDecimals: 7 })
    ).toEqual(['tokenAddress:INVALID_CONTRACT_ADDRESS']);
    expect(codes({ ...base, formType: 'AddToken' })).toEqual(['tokenAddress:REQUIRED']);
  });

  it('rejects already-accepted tokens and unresolved decimals', () => {
    expect(codes({ ...base, formType: 'AddToken', tokenAddress: USDC, tokenDecimals: 7 })).toEqual([
      'tokenAddress:ALREADY_ACCEPTED',
    ]);
    expect(codes({ ...base, formType: 'AddToken', tokenAddress: XLM_SAC })).toEqual([
      'tokenAddress:DECIMALS_UNRESOLVED',
    ]);
  });

  it('builds AddToken with the decimals read from the token', () => {
    const result = validateProposalPayload(
      { ...base, formType: 'AddToken', tokenAddress: XLM_SAC, tokenDecimals: 7 },
      context
    );
    expect(result.ok && result.proposal).toMatchObject({
      action: { kind: 'AddToken', token: XLM_SAC, decimals: 7 },
      proposedValue: 0n,
    });
  });

  it('only removes tokens that are currently accepted', () => {
    expect(codes({ ...base, formType: 'RemoveToken', removeTokenAddress: XLM_SAC })).toEqual([
      'removeTokenAddress:NOT_ACCEPTED',
    ]);
    expect(codes({ ...base, formType: 'RemoveToken' })).toEqual(['removeTokenAddress:REQUIRED']);
    expect(codes({ ...base, formType: 'RemoveToken', removeTokenAddress: USDC })).toEqual([]);
  });

  it('rejects unknown actions', () => {
    expect(
      codes({ ...base, formType: 'Upgrade' as unknown as CreateProposalPayload['formType'] })
    ).toEqual(['formType:UNSUPPORTED_ACTION']);
  });
});

describe('issuesByField', () => {
  it('keeps the first message per field', () => {
    expect(
      issuesByField([
        { field: 'title', code: 'REQUIRED', message: 'first' },
        { field: 'title', code: 'TOO_LONG', message: 'second' },
      ])
    ).toEqual({ title: 'first' });
  });
});

describe('contract encoding', () => {
  it('encodes ProposalAction tuple variants as Vec[Symbol, ...fields]', () => {
    expect(scValToNative(encodeProposalAction({ kind: 'UpdateFeeRate', rateBps: 25 }))).toEqual([
      'UpdateFeeRate',
      25,
    ]);
    expect(
      scValToNative(encodeProposalAction({ kind: 'AddToken', token: XLM_SAC, decimals: 7 }))
    ).toEqual(['AddToken', XLM_SAC, 7]);
    expect(scValToNative(encodeProposalAction({ kind: 'RemoveToken', token: USDC }))).toEqual([
      'RemoveToken',
      USDC,
    ]);
    const vec = encodeProposalAction({ kind: 'UpdateMaxDiscountRate', rateBps: 400 }).vec()!;
    expect(vec[1].switch()).toBe(xdr.ScValType.scvU32());
  });

  it('hashes canonical text deterministically', async () => {
    expect(canonicalProposalText('T', 'D')).toBe('{"description":"D","title":"T","v":1}');
    const a = toHex(await proposalDescriptionHash('T', 'D'));
    const b = toHex(await proposalDescriptionHash('T', 'D'));
    const c = toHex(await proposalDescriptionHash('T', 'D2'));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('produces create_proposal arguments in contract order', async () => {
    const args = await encodeCreateProposalArgs(PROPOSER, {
      action: { kind: 'UpdateFeeRate', rateBps: 20 },
      title: base.title,
      description: base.description,
      proposedValue: 20n,
    });
    expect(args).toHaveLength(4);
    expect(Address.fromScVal(args[0]).toString()).toBe(PROPOSER);
    expect(scValToNative(args[1])).toEqual(['UpdateFeeRate', 20]);
    expect(args[2].switch()).toBe(xdr.ScValType.scvBytes());
    expect(args[2].bytes()).toHaveLength(32);
    expect(toHex(new Uint8Array(args[2].bytes()))).toBe(
      toHex(await proposalDescriptionHash(base.title, base.description))
    );
    expect(args[3].switch()).toBe(xdr.ScValType.scvI128());
    expect(scValToNative(args[3])).toBe(20n);
  });
});
