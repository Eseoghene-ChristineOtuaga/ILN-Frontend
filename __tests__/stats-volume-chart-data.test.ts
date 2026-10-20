import { describe, it, expect } from 'vitest';
import type { DailyVolumeBucket } from '@/utils/contract-stats';
import {
  parseContractStatsForStackedBar,
  dailyTokenVolumeUsd,
  TOKEN_USD_RATES,
} from '@/utils/stats-volume-chart-data';

function makeDay(date: string, overrides: Partial<DailyVolumeBucket> = {}): DailyVolumeBucket {
  return {
    date,
    label: date,
    volume_usd: 0,
    usdc: 0,
    eurc: 0,
    xlm: 0,
    ...overrides,
  };
}

describe('dailyTokenVolumeUsd', () => {
  it('converts per-token raw amounts to USD using oracle rates', () => {
    const usd = dailyTokenVolumeUsd(makeDay('2025-06-01', { usdc: 100, eurc: 50, xlm: 1000 }));
    expect(usd.USDC).toBeCloseTo(100 * TOKEN_USD_RATES.USDC, 5);
    expect(usd.EURC).toBeCloseTo(50 * TOKEN_USD_RATES.EURC, 5);
    expect(usd.XLM).toBeCloseTo(1000 * TOKEN_USD_RATES.XLM, 5);
  });
});

describe('parseContractStatsForStackedBar', () => {
  it('returns empty weekly bars and zero total for empty input', () => {
    const result = parseContractStatsForStackedBar([], 30);
    expect(result.weeklyBars).toEqual([]);
    expect(result.totalVolumeUsd).toBe(0);
  });

  it('uses only the last N days for the selected range', () => {
    const days = Array.from({ length: 10 }, (_, i) => {
      const day = String(i + 1).padStart(2, '0');
      return makeDay(`2025-06-${day}`, { volume_usd: 1, usdc: 1 });
    });
    const result = parseContractStatsForStackedBar(days, 30);
    expect(result.totalVolumeUsd).toBe(10);
    expect(result.weeklyBars.length).toBeGreaterThan(0);
  });

  it('aggregates multiple days in the same ISO week into one bar', () => {
    // 2025-06-02 (Mon) and 2025-06-03 (Tue) share week starting 2025-06-02
    const days = [
      makeDay('2025-06-02', { usdc: 10, volume_usd: 10 }),
      makeDay('2025-06-03', { usdc: 5, volume_usd: 5 }),
    ];
    const result = parseContractStatsForStackedBar(days, 30);
    expect(result.weeklyBars).toHaveLength(1);
    expect(result.weeklyBars[0]!.USDC).toBeCloseTo(15, 5);
    expect(result.totalVolumeUsd).toBe(15);
  });

  it('splits days in different weeks into separate bars', () => {
    const days = [
      makeDay('2025-06-02', { usdc: 10, volume_usd: 10 }),
      makeDay('2025-06-09', { usdc: 20, volume_usd: 20 }),
    ];
    const result = parseContractStatsForStackedBar(days, 30);
    expect(result.weeklyBars).toHaveLength(2);
    expect(result.weeklyBars[0]!.USDC).toBeCloseTo(10, 5);
    expect(result.weeklyBars[1]!.USDC).toBeCloseTo(20, 5);
  });

  it('sums volume_usd across the period for the summary total', () => {
    const days = [
      makeDay('2025-06-01', { volume_usd: 100, usdc: 100 }),
      makeDay('2025-06-02', { volume_usd: 50, usdc: 50 }),
    ];
    expect(parseContractStatsForStackedBar(days, 90).totalVolumeUsd).toBe(150);
  });

  it('respects a 90-day window when more than 90 days are provided', () => {
    const days = Array.from({ length: 100 }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, '0');
      return makeDay(`2025-01-${day}`, { volume_usd: 1, usdc: 1 });
    });
    const result = parseContractStatsForStackedBar(days, 90);
    expect(result.totalVolumeUsd).toBe(90);
  });

  it('stacks EURC and XLM USD separately within a week', () => {
    const days = [
      makeDay('2025-06-02', { eurc: 10, xlm: 100, volume_usd: 10 * 1.08 + 100 * 0.12 }),
    ];
    const result = parseContractStatsForStackedBar(days, 30);
    expect(result.weeklyBars[0]!.EURC).toBeCloseTo(10 * TOKEN_USD_RATES.EURC, 5);
    expect(result.weeklyBars[0]!.XLM).toBeCloseTo(100 * TOKEN_USD_RATES.XLM, 5);
  });

  it('derives the chart total from the same token units as the bars', () => {
    const result = parseContractStatsForStackedBar(
      [makeDay('2025-06-02', { volume_usd: 999, usdc: 10 })],
      30
    );

    expect(result.totalVolumeUsd).toBe(10);
    expect(result.sourceTotalVolumeUsd).toBe(999);
    expect(result.reconciliationDeltaUsd).toBe(-989);
  });
});
