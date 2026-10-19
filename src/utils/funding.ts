import { type DailyFundingBucket } from '@/lib/indexerClient';

export function transformFundingData(data: DailyFundingBucket[]) {
  return data.map((bucket) => {
    const row: any = {
      ...bucket,
    };
    bucket.tokens.forEach((t) => {
      row[t.symbol] = t.amount;
    });
    return row;
  });
}
