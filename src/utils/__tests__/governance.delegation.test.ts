/**
 * @file governance.delegation.test.ts
 *
 * Unit tests for contract-backed delegation queries and transactions:
 *  - normalizeDelegatedAddress and normalizeDelegatedAmount unit decoding
 *  - parseDelegationInfoFromNative tuple and struct parsing
 *  - getDelegationInfo contract simulation and error handling
 *  - delegateVotingPower signed transaction path, session gating, validation,
 *    and deterministic tx hash provenance
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DelegationError,
  normalizeDelegatedAddress,
  normalizeDelegatedAmount,
  parseDelegationInfoFromNative,
  getDelegationInfo,
  delegateVotingPower,
} from '../governance';
import {
  establishGovernanceTestSession,
  clearGovernanceTestSession,
} from './helpers/governanceSession';
import { rpc, nativeToScVal } from '@stellar/stellar-sdk';

const SIGNER = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const DELEGATE = 'GBQD2MXHXD2SRHRQZRZ5JZ4UNLMTMLZNNDJHCQXIJXE2ANBV5IDWB2XK';

describe('governance delegation normalization and parsing', () => {
  describe('normalizeDelegatedAddress', () => {
    it('returns a valid 56-character Stellar G address', () => {
      expect(normalizeDelegatedAddress(DELEGATE)).toBe(DELEGATE);
    });

    it('returns a valid C contract address', () => {
      const contractAddr = 'CA3D5KRYM6CB7OWQ6TWYRR3Z4T7GNZLKERYNZGGA5SOAOPIFY6YQGAXE';
      expect(normalizeDelegatedAddress(contractAddr)).toBe(contractAddr);
    });

    it('trims leading and trailing whitespace', () => {
      expect(normalizeDelegatedAddress(`  ${DELEGATE}  `)).toBe(DELEGATE);
    });

    it('extracts address from ScAddress or objects with toString', () => {
      const obj = { toString: () => DELEGATE };
      expect(normalizeDelegatedAddress(obj)).toBe(DELEGATE);
    });

    it('returns null for "none" (case-insensitive) or empty strings', () => {
      expect(normalizeDelegatedAddress('none')).toBeNull();
      expect(normalizeDelegatedAddress('None')).toBeNull();
      expect(normalizeDelegatedAddress('NONE')).toBeNull();
      expect(normalizeDelegatedAddress('')).toBeNull();
      expect(normalizeDelegatedAddress('   ')).toBeNull();
    });

    it('returns null for invalid strkeys or non-string/non-object primitives', () => {
      expect(normalizeDelegatedAddress(null)).toBeNull();
      expect(normalizeDelegatedAddress(undefined)).toBeNull();
      expect(normalizeDelegatedAddress(12345)).toBeNull();
      expect(normalizeDelegatedAddress('GSHORT')).toBeNull();
      expect(
        normalizeDelegatedAddress('INVALID_ADDRESS_CHARACTERS_NOT_BASE32_9999999999999999999999')
      ).toBeNull();
    });
  });

  describe('normalizeDelegatedAmount', () => {
    it('scales 7-decimal Soroban base units to whole tokens', () => {
      expect(normalizeDelegatedAmount(1250_0000000n)).toBe(1250);
      expect(normalizeDelegatedAmount('50000000000')).toBe(5000);
    });

    it('handles numeric and bigint values safely', () => {
      expect(normalizeDelegatedAmount(750)).toBe(750);
      expect(normalizeDelegatedAmount(1000n)).toBe(1000);
    });

    it('handles custom decimals', () => {
      expect(normalizeDelegatedAmount(500_000000n, 6)).toBe(500);
    });

    it('returns 0 for negative, zero, or non-finite inputs', () => {
      expect(normalizeDelegatedAmount(0)).toBe(0);
      expect(normalizeDelegatedAmount(-100n)).toBe(0);
      expect(normalizeDelegatedAmount(null)).toBe(0);
      expect(normalizeDelegatedAmount(undefined)).toBe(0);
      expect(normalizeDelegatedAmount(Infinity)).toBe(0);
      expect(normalizeDelegatedAmount(NaN)).toBe(0);
      expect(normalizeDelegatedAmount('invalid_amount')).toBe(0);
    });
  });

  describe('parseDelegationInfoFromNative', () => {
    it('parses tuple responses [delegate, amount, incoming]', () => {
      const result = parseDelegationInfoFromNative([DELEGATE, 1250_0000000n, 450_0000000n]);
      expect(result).toEqual({
        delegatedTo: DELEGATE,
        delegatedAmount: 1250,
        incomingDelegations: 450,
      });
    });

    it('parses struct responses with snake_case and camelCase fields', () => {
      const resultSnake = parseDelegationInfoFromNative({
        delegated_to: DELEGATE,
        delegated_amount: 1000,
        incoming_delegations: 200,
      });
      expect(resultSnake).toEqual({
        delegatedTo: DELEGATE,
        delegatedAmount: 1000,
        incomingDelegations: 200,
      });

      const resultCamel = parseDelegationInfoFromNative({
        delegate: DELEGATE,
        amount: 800,
        incoming: 150,
      });
      expect(resultCamel).toEqual({
        delegatedTo: DELEGATE,
        delegatedAmount: 800,
        incomingDelegations: 150,
      });
    });

    it('handles undelegated or empty responses', () => {
      const result = parseDelegationInfoFromNative(null);
      expect(result).toEqual({
        delegatedTo: null,
        delegatedAmount: 0,
        incomingDelegations: 0,
      });
    });
  });
});

describe('governance getDelegationInfo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects invalid or missing Stellar addresses with DelegationError', async () => {
    await expect(getDelegationInfo('')).rejects.toThrow(DelegationError);
    await expect(getDelegationInfo('INVALID')).rejects.toThrow(DelegationError);
  });

  it('queries contract-backed delegation data from simulation', async () => {
    const scValResult = nativeToScVal([DELEGATE, 1250_0000000n, 450_0000000n]);
    vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue({
      id: 'sim-1',
      latestLedger: 100,
      transactionData: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      minResourceFee: '100',
      result: {
        retval: scValResult,
        auth: [],
      },
    } as unknown as rpc.Api.SimulateTransactionResponse);

    const info = await getDelegationInfo(SIGNER);
    expect(info.delegatedTo).toBe(DELEGATE);
    expect(info.delegatedAmount).toBe(1250);
    expect(info.incomingDelegations).toBe(450);
  });

  it('handles undelegated response from contract simulation', async () => {
    const scValResult = nativeToScVal(['none', 0n, 0n]);
    vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue({
      id: 'sim-2',
      latestLedger: 100,
      transactionData: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      minResourceFee: '100',
      result: {
        retval: scValResult,
        auth: [],
      },
    } as unknown as rpc.Api.SimulateTransactionResponse);

    const info = await getDelegationInfo(SIGNER);
    expect(info.delegatedTo).toBeNull();
    expect(info.delegatedAmount).toBe(0);
    expect(info.incomingDelegations).toBe(0);
  });

  it('fails closed and throws DelegationError on simulation failure', async () => {
    vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockRejectedValue(
      new Error('RPC connection refused')
    );

    await expect(getDelegationInfo(SIGNER)).rejects.toThrow(DelegationError);
  });

  it('fails closed when contract simulation returns error property', async () => {
    vi.spyOn(rpc.Server.prototype, 'simulateTransaction').mockResolvedValue({
      id: 'sim-err',
      latestLedger: 100,
      error: 'Host error during get_delegation',
    } as unknown as rpc.Api.SimulateTransactionResponse);

    await expect(getDelegationInfo(SIGNER)).rejects.toThrow(DelegationError);
  });
});

describe('governance delegateVotingPower', () => {
  beforeEach(() => {
    establishGovernanceTestSession(SIGNER);
  });

  afterEach(() => {
    clearGovernanceTestSession();
    vi.restoreAllMocks();
  });

  it('requires an active SEP-10 session', async () => {
    clearGovernanceTestSession();
    const signTx = vi.fn();
    await expect(delegateVotingPower(DELEGATE, SIGNER, signTx)).rejects.toThrow(
      'SEP10_SESSION_REQUIRED'
    );
  });

  it('rejects invalid signer address', async () => {
    const invalidSigner = 'GINVALID123';
    establishGovernanceTestSession(invalidSigner);
    const signTx = vi.fn();
    await expect(delegateVotingPower(DELEGATE, invalidSigner, signTx)).rejects.toThrow(
      'Invalid signer address for delegation'
    );
  });

  it('rejects invalid delegate address', async () => {
    const signTx = vi.fn();
    await expect(delegateVotingPower('INVALID_DELEGATE', SIGNER, signTx)).rejects.toThrow(
      'Invalid delegate address'
    );
  });

  it('prevents self-delegation with DelegationError', async () => {
    const signTx = vi.fn();
    await expect(delegateVotingPower(SIGNER, SIGNER, signTx)).rejects.toThrow(
      'Cannot delegate voting power to yourself'
    );
  });

  it('delegates voting power to a valid delegate with signed intent and deterministic hash', async () => {
    const signTx = vi.fn(async (intent: string) => `signed:${intent}`);
    const onConfirmed = vi.fn();

    const txHash = await delegateVotingPower(DELEGATE, SIGNER, signTx, { onConfirmed });

    expect(signTx).toHaveBeenCalledWith(`delegate:${SIGNER}:${DELEGATE}`);
    expect(typeof txHash).toBe('string');
    expect(txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(onConfirmed).toHaveBeenCalledWith(txHash);

    // Determinism test: identical call produces identical hash
    const secondHash = await delegateVotingPower(DELEGATE, SIGNER, signTx);
    expect(secondHash).toBe(txHash);
  });

  it('removes delegation when delegateAddress is null', async () => {
    const signTx = vi.fn(async (intent: string) => `signed:${intent}`);
    const txHash = await delegateVotingPower(null, SIGNER, signTx);

    expect(signTx).toHaveBeenCalledWith(`undelegate:${SIGNER}`);
    expect(txHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails closed when dry-run simulation fails', async () => {
    const signTx = vi.fn();
    const simulateFailure = async () => ({
      success: false,
      error: 'Simulation failed: unauthorized caller',
    });

    await expect(
      delegateVotingPower(DELEGATE, SIGNER, signTx, { simulate: simulateFailure })
    ).rejects.toThrow('GOVERNANCE_SIMULATION_FAILED');
    expect(signTx).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent in-flight delegation requests', async () => {
    let signCalls = 0;
    const signTx = vi.fn(async (intent: string) => {
      signCalls++;
      await new Promise((r) => setTimeout(r, 20));
      return `signed:${intent}`;
    });

    const [hash1, hash2] = await Promise.all([
      delegateVotingPower(DELEGATE, SIGNER, signTx),
      delegateVotingPower(DELEGATE, SIGNER, signTx),
    ]);

    expect(hash1).toBe(hash2);
    expect(signCalls).toBe(1);
  });
});
