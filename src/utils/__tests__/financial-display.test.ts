import { describe, expect, it } from 'vitest';
import {
  createFinancialProvenance,
  formatFinancialUsd,
  getRateFreshness,
} from '@/utils/financial-display';

describe('financial display helpers', () => {
  it('uses an explicit unavailable fallback for invalid financial values', () => {
    expect(formatFinancialUsd(undefined)).toBe('Unavailable');
    expect(formatFinancialUsd(Number.NaN)).toBe('Unavailable');
    expect(formatFinancialUsd(Number.POSITIVE_INFINITY)).toBe('Unavailable');
  });

  it('preserves readable USD formatting for valid values', () => {
    expect(formatFinancialUsd(12.5)).toBe('$12.5');
    expect(formatFinancialUsd(12_500)).toBe('$12.5K');
    expect(formatFinancialUsd(2_500_000)).toBe('$2.50M');
  });

  it('distinguishes fresh, stale, and unknown rate timestamps', () => {
    const now = 1_000_000;
    expect(getRateFreshness(now - 299_000, now, 300)).toBe('fresh');
    expect(getRateFreshness(now - 301_000, now, 300)).toBe('stale');
    expect(getRateFreshness(undefined, now, 300)).toBe('unknown');
    expect(getRateFreshness(now + 1, now, 300)).toBe('stale');
  });

  it('labels fallback and reference-rate provenance explicitly', () => {
    expect(createFinancialProvenance('fallback').label).toBe('Fallback value');
    expect(createFinancialProvenance('reference-rate').label).toBe('Reference-rate estimate');
  });
});
