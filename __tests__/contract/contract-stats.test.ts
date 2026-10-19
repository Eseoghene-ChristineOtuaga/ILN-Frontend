/**
 * Contract integration tests for src/utils/contract-stats.ts
 * Tests get_contract_stats, buildHistoricalVolume, and related helpers.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { get_contract_stats, buildHistoricalVolume, TOKEN_COLORS } from '@/utils/contract-stats';
import type { Invoice } from '@/utils/soroban';

const USDC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
const EURC = 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV';

// Partial mock: only the ids this suite pins are overridden. A wholesale
// replacement breaks whenever a new constant is added and read at module
// load (e.g. GOVERNANCE_CONTRACT_CONFIGURED), so spread the real module.
vi.mock('@/constants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/constants')>();
  return {
    ...actual,
    CONTRACT_ID: 'CTEST',
    NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
    RPC_URL: 'https://soroban-testnet.stellar.org',
    TESTNET_USDC_TOKEN_ID: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    TESTNET_EURC_TOKEN_ID: 'CDTKPWPLOURQA2SGTKTUQOWRCBZEORB4BWBOMJ3D3ZTQQSGE5F6JBQLV',
    TESTNET_XLM_TOKEN_ID: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
  };
});

// Mock getAllInvoices so we don't hit the real RPC
vi.mock('@/utils/soroban', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/soroban')>();
  return {
    ...actual,
    getAllInvoices: vi.fn(),
  };
});

vi.mock('@/lib/fetch-protocol-contract-events', () => ({
  fetchProtocolContractEvents: vi.fn().mockResolvedValue([]),
}));

import { getAllInvoices } from '@/utils/soroban';

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: BigInt(1),
    status: 'Pending',
    freelancer: 'GAAAA',
    payer: 'GBBBB',
    amount: BigInt(100_000_000),
    due_date: BigInt(now + 86400 * 30),
    discount_rate: 250,
    token: USDC,
    ...overrides,
  };
}

describe('get_contract_stats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns zeroed stats for empty invoice list', async () => {
    vi.mocked(getAllInvoices).mockResolvedValue([]);

    const stats = await get_contract_stats();

    expect(stats.total_invoices).toBe(0);
    expect(stats.total_funded).toBe(0);
    expect(stats.total_paid).toBe(0);
    expect(stats.total_volume_usd).toBe(0);
    expect(Array.isArray(stats.volume_by_token)).toBe(true);
  });

  it('counts all invoices regardless of status', async () => {
    vi.mocked(getAllInvoices).mockResolvedValue([
      makeInvoice({ id: BigInt(1), status: 'Pending' }),
      makeInvoice({ id: BigInt(2), status: 'Funded' }),
      makeInvoice({ id: BigInt(3), status: 'Paid' }),
    ]);

    const stats = await get_contract_stats();
    expect(stats.total_invoices).toBe(3);
  });

  it('counts funded invoices including Paid and Defaulted', async () => {
    vi.mocked(getAllInvoices).mockResolvedValue([
      makeInvoice({ id: BigInt(1), status: 'Pending' }),
      makeInvoice({ id: BigInt(2), status: 'Funded' }),
      makeInvoice({ id: BigInt(3), status: 'Paid' }),
      makeInvoice({ id: BigInt(4), status: 'Defaulted' }),
    ]);

    const stats = await get_contract_stats();
    expect(stats.total_funded).toBe(3); // Funded + Paid + Defaulted
  });

  it('counts only Paid invoices in total_paid', async () => {
    vi.mocked(getAllInvoices).mockResolvedValue([
      makeInvoice({ id: BigInt(1), status: 'Funded' }),
      makeInvoice({ id: BigInt(2), status: 'Paid' }),
      makeInvoice({ id: BigInt(3), status: 'Paid' }),
    ]);

    const stats = await get_contract_stats();
    expect(stats.total_paid).toBe(2);
  });

  it('calculates USD volume correctly for USDC invoices', async () => {
    vi.mocked(getAllInvoices).mockResolvedValue([
      makeInvoice({
        id: BigInt(1),
        status: 'Funded',
        amount: BigInt(100_000_000), // 100 USDC (6 decimals)
        token: USDC,
        funded_at: BigInt(Math.floor(Date.now() / 1000) - 3600),
      }),
    ]);

    const stats = await get_contract_stats();
    // 100_000_000 / 10^6 * 1.0 = 100 USD
    expect(stats.total_volume_usd).toBeCloseTo(100, 0);
  });

  it('calculates USD volume correctly for EURC invoices', async () => {
    vi.mocked(getAllInvoices).mockResolvedValue([
      makeInvoice({
        id: BigInt(1),
        status: 'Funded',
        amount: BigInt(10_000_000), // 1 EURC (7 decimals)
        token: EURC,
        funded_at: BigInt(Math.floor(Date.now() / 1000) - 3600),
      }),
    ]);

    const stats = await get_contract_stats();
    // 10_000_000 / 10^7 * 1.08 = 1.08 USD
    expect(stats.total_volume_usd).toBeCloseTo(1.08, 1);
  });

  it('includes volume_by_token breakdown with all three tokens', async () => {
    vi.mocked(getAllInvoices).mockResolvedValue([]);

    const stats = await get_contract_stats();
    const symbols = stats.volume_by_token.map((v) => v.symbol);
    expect(symbols).toContain('USDC');
    expect(symbols).toContain('EURC');
    expect(symbols).toContain('XLM');
  });

  it('volume percentages sum to 100 when there is volume', async () => {
    vi.mocked(getAllInvoices).mockResolvedValue([
      makeInvoice({
        id: BigInt(1),
        status: 'Paid',
        amount: BigInt(100_000_000),
        token: USDC,
        funded_at: BigInt(Math.floor(Date.now() / 1000) - 3600),
      }),
      makeInvoice({
        id: BigInt(2),
        status: 'Funded',
        amount: BigInt(100_000_000),
        token: EURC,
        funded_at: BigInt(Math.floor(Date.now() / 1000) - 3600),
      }),
    ]);

    const stats = await get_contract_stats();
    const total = stats.volume_by_token.reduce((acc, t) => acc + t.percentage, 0);
    expect(total).toBeCloseTo(100, 1);
  });

  it('includes daily_volume for 90 days', async () => {
    vi.mocked(getAllInvoices).mockResolvedValue([]);

    const stats = await get_contract_stats();
    expect(stats.daily_volume.length).toBe(90);
  });
});

describe('buildHistoricalVolume', () => {
  const recentTimestamp = BigInt(Math.floor(Date.now() / 1000) - 86400); // yesterday

  it('returns exactly N buckets for N days', () => {
    const buckets = buildHistoricalVolume([], 30);
    expect(buckets.length).toBe(30);
  });

  it('each bucket has date, label, and volume fields', () => {
    const buckets = buildHistoricalVolume([], 7);
    for (const bucket of buckets) {
      expect(bucket).toHaveProperty('date');
      expect(bucket).toHaveProperty('label');
      expect(bucket).toHaveProperty('volume_usd');
      expect(bucket).toHaveProperty('usdc');
      expect(bucket).toHaveProperty('eurc');
      expect(bucket).toHaveProperty('xlm');
    }
  });

  it('accumulates USDC volume into the correct day bucket', () => {
    const invoices: Invoice[] = [
      makeInvoice({
        status: 'Funded',
        amount: BigInt(1_000_000), // 1 USDC
        token: USDC,
        funded_at: recentTimestamp,
      }),
    ];

    const buckets = buildHistoricalVolume(invoices, 7);
    const totalUsdc = buckets.reduce((acc, b) => acc + b.usdc, 0);
    expect(totalUsdc).toBeCloseTo(1, 2);
  });

  it('excludes Pending invoices from volume', () => {
    const invoices: Invoice[] = [
      makeInvoice({
        status: 'Pending',
        amount: BigInt(1_000_000),
        token: USDC,
        funded_at: recentTimestamp,
      }),
    ];

    const buckets = buildHistoricalVolume(invoices, 7);
    const totalVolume = buckets.reduce((acc, b) => acc + b.volume_usd, 0);
    expect(totalVolume).toBe(0);
  });

  it('excludes invoices older than the window', () => {
    const oldTimestamp = BigInt(Math.floor(Date.now() / 1000) - 90 * 86400 - 1);
    const invoices: Invoice[] = [
      makeInvoice({
        status: 'Funded',
        amount: BigInt(1_000_000),
        token: USDC,
        funded_at: oldTimestamp,
      }),
    ];

    const buckets = buildHistoricalVolume(invoices, 7);
    const totalVolume = buckets.reduce((acc, b) => acc + b.volume_usd, 0);
    expect(totalVolume).toBe(0);
  });
});

describe('TOKEN_COLORS', () => {
  it('has color entries for USDC, EURC, XLM', () => {
    expect(TOKEN_COLORS['USDC']).toBeDefined();
    expect(TOKEN_COLORS['EURC']).toBeDefined();
    expect(TOKEN_COLORS['XLM']).toBeDefined();
  });
});
