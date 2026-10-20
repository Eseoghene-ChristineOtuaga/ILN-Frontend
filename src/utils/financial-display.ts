export type FinancialDataSource = 'on-chain' | 'indexer' | 'reference-rate' | 'fallback';

export type RateFreshness = 'fresh' | 'stale' | 'unknown';

export interface FinancialProvenance {
  source: FinancialDataSource;
  label: string;
  updatedAt?: number;
  maxAgeSeconds?: number;
}

const SOURCE_LABELS: Record<FinancialDataSource, string> = {
  'on-chain': 'On-chain data',
  indexer: 'Indexer data',
  'reference-rate': 'Reference-rate estimate',
  fallback: 'Fallback value',
};

export function createFinancialProvenance(
  source: FinancialDataSource,
  updatedAt?: number,
  maxAgeSeconds?: number
): FinancialProvenance {
  return { source, label: SOURCE_LABELS[source], updatedAt, maxAgeSeconds };
}

export function getRateFreshness(
  updatedAt: number | undefined,
  now = Date.now(),
  maxAgeSeconds = 300
): RateFreshness {
  if (!Number.isFinite(updatedAt) || updatedAt === undefined) return 'unknown';
  if (updatedAt > now) return 'stale';
  return now - updatedAt <= maxAgeSeconds * 1000 ? 'fresh' : 'stale';
}

export function formatFinancialUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'Unavailable';
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}
