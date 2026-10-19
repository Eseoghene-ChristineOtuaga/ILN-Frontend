import { type MonthlyDefaultBucket } from '@/lib/indexerClient';

// Re-exported so existing importers keep working after the schemas moved (#1105).
export type { MonthlyDefaultBucket };

export interface MonthlyDefaultWithMA extends MonthlyDefaultBucket {
  movingAverage: number;
}

export function calculateMovingAverage(
  data: MonthlyDefaultBucket[],
  windowSize: number = 1
): MonthlyDefaultWithMA[] {
  if (data.length === 0) return [];

  return data.map((bucket, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const slice = data.slice(start, index + 1);
    const avg = slice.reduce((sum, b) => sum + b.defaultRate, 0) / slice.length;

    return {
      ...bucket,
      movingAverage: Math.round(avg * 100) / 100,
    };
  });
}
