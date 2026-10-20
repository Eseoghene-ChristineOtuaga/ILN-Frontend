import type { DailyVolumeBucket } from '@/utils/contract-stats';

/** Stacked bar colours: USDC blue, EURC yellow, XLM black */
export const CHART_TOKEN_COLORS: Record<string, string> = {
  USDC: '#2563eb',
  EURC: '#eab308',
  XLM: '#000000',
};

/** Oracle USD rates (aligned with contract-stats getTokenInfo) */
export const TOKEN_USD_RATES: Record<'USDC' | 'EURC' | 'XLM', number> = {
  USDC: 1.0,
  EURC: 1.08,
  XLM: 0.12,
};

export type VolumeChartRangeDays = 30 | 90;

export interface WeeklyVolumeBar {
  weekStart: string;
  label: string;
  USDC: number;
  EURC: number;
  XLM: number;
}

export interface StackedVolumeChartData {
  weeklyBars: WeeklyVolumeBar[];
  totalVolumeUsd: number;
  sourceTotalVolumeUsd: number;
  reconciliationDeltaUsd: number;
}

function getWeekStartUtc(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const day = d.getUTCDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  return d.toISOString().slice(0, 10);
}

function formatWeekLabel(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00.000Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function dailyTokenVolumeUsd(bucket: DailyVolumeBucket): {
  USDC: number;
  EURC: number;
  XLM: number;
} {
  return {
    USDC: bucket.usdc * TOKEN_USD_RATES.USDC,
    EURC: bucket.eurc * TOKEN_USD_RATES.EURC,
    XLM: bucket.xlm * TOKEN_USD_RATES.XLM,
  };
}

/**
 * Parse get_contract_stats() daily_volume into weekly stacked-bar series and period USD total.
 */
export function parseContractStatsForStackedBar(
  dailyVolume: DailyVolumeBucket[],
  rangeDays: VolumeChartRangeDays
): StackedVolumeChartData {
  const periodDays = dailyVolume.slice(-rangeDays);
  const weekMap = new Map<string, WeeklyVolumeBar>();

  for (const day of periodDays) {
    const weekStart = getWeekStartUtc(day.date);
    const tokenUsd = dailyTokenVolumeUsd(day);

    let bar = weekMap.get(weekStart);
    if (!bar) {
      bar = {
        weekStart,
        label: formatWeekLabel(weekStart),
        USDC: 0,
        EURC: 0,
        XLM: 0,
      };
      weekMap.set(weekStart, bar);
    }

    bar.USDC += tokenUsd.USDC;
    bar.EURC += tokenUsd.EURC;
    bar.XLM += tokenUsd.XLM;
  }

  const weeklyBars = Array.from(weekMap.values()).sort((a, b) =>
    a.weekStart.localeCompare(b.weekStart)
  );

  const sourceTotalVolumeUsd = periodDays.reduce(
    (sum, d) => sum + (Number.isFinite(d.volume_usd) ? d.volume_usd : 0),
    0
  );
  // Derive the displayed total from the same normalized token units as the bars.
  // This prevents a USD summary field from disagreeing with the chart values.
  const totalVolumeUsd = weeklyBars.reduce((sum, bar) => sum + bar.USDC + bar.EURC + bar.XLM, 0);

  return {
    weeklyBars,
    totalVolumeUsd,
    sourceTotalVolumeUsd,
    reconciliationDeltaUsd: totalVolumeUsd - sourceTotalVolumeUsd,
  };
}
