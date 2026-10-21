/**
 * Live Soroban testnet smoke test for issue #844.
 *
 * Opt in with:
 *   ILN_LIVE_GOVERNANCE_TESTNET=1 NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID=<deployed governance C...>
 *   NEXT_PUBLIC_ILN_TOKEN_CONTRACT_ID=<deployed ILN token C...> pnpm exec vitest run src/lib/governance/__tests__/protocol-parameters.testnet.test.ts
 *
 * This deliberately uses the production fetchProtocolParameters path without
 * mocking RPC, simulation, contract reads, or confirmed event queries.
 */
import { describe, expect, it } from 'vitest';
import { fetchProtocolParameters, ChainParametersError } from '@/utils/governance';

const enabled = process.env.ILN_LIVE_GOVERNANCE_TESTNET === '1';
const governanceId = process.env.NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID;
const tokenId = process.env.NEXT_PUBLIC_ILN_TOKEN_CONTRACT_ID;
const network = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'testnet';
const passphrase =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015';
const rpcUrl = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const contractIdPattern = /^C[A-Z2-7]{55}$/;

describe.skipIf(!enabled)('fetchProtocolParameters live Soroban testnet (#844)', () => {
  it('reads real protocol parameters without a mock fallback', async () => {
    // Fail explicitly for bad opt-in configuration; never accidentally read
    // the invoice-contract fallback as though it were governance.
    expect(network.toLowerCase()).toBe('testnet');
    expect(passphrase).toBe('Test SDF Network ; September 2015');
    expect(new URL(rpcUrl).protocol).toBe('https:');
    expect(governanceId).toMatch(contractIdPattern);
    expect(tokenId).toMatch(contractIdPattern);

    let parameters: Awaited<ReturnType<typeof fetchProtocolParameters>>;
    try {
      parameters = await fetchProtocolParameters();
    } catch (error) {
      if (error instanceof ChainParametersError) {
        throw new Error(
          `Live governance reads failed: ${error.failed.join(', ')}. Check deployed contract IDs, RPC availability, and testnet state.`,
          { cause: error }
        );
      }
      throw error;
    }

    expect(parameters.minProposalBalance).toBeTypeOf('bigint');
    expect(parameters.minProposalDeposit).toBeTypeOf('bigint');
    expect(parameters.govTokenTotalSupply).toBeTypeOf('bigint');
    expect(parameters.minProposalBalance).toBeGreaterThanOrEqual(0n);
    expect(parameters.minProposalDeposit).toBeGreaterThanOrEqual(0n);
    expect(parameters.govTokenTotalSupply).toBeGreaterThanOrEqual(0n);
    expect(parameters.quorumThresholdBps).toBeGreaterThanOrEqual(1);
    expect(parameters.quorumThresholdBps).toBeLessThanOrEqual(10_000);
    expect(parameters.govTokenDecimals).toBeGreaterThanOrEqual(0);
    expect(parameters.govTokenDecimals).toBeLessThanOrEqual(18);
    expect(Array.isArray(parameters.acceptedTokens)).toBe(true);
    expect(parameters.unconfirmed).toEqual(
      expect.arrayContaining(
        [
          ...(parameters.feeRateBps === null ? ['feeRateBps'] : []),
          ...(parameters.maxDiscountRateBps === null ? ['maxDiscountRateBps'] : []),
        ]
      )
    );
  }, 60_000);
});
