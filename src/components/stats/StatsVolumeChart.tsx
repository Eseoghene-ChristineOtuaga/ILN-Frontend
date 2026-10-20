'use client';

import React, { useMemo, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  type TooltipProps,
} from 'recharts';
import type { DailyVolumeBucket } from '@/utils/contract-stats';
import {
  CHART_TOKEN_COLORS,
  parseContractStatsForStackedBar,
  type VolumeChartRangeDays,
} from '@/utils/stats-volume-chart-data';
import { formatFinancialUsd } from '@/utils/financial-display';

const TOKEN_KEYS = ['USDC', 'EURC', 'XLM'] as const;

const CHART_TICK_STYLE = {
  fill: 'var(--color-on-surface-variant, #94a3b8)',
  fontSize: 11,
  fontFamily: 'inherit',
};
const GRID_STROKE = 'var(--color-outline-variant, #334155)';

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;
  const total = payload.reduce((sum, e) => sum + (e.value as number), 0);
  return (
    <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-4 py-3 shadow-xl">
      <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-on-surface-variant">
        Week of {label}
      </p>
      <div className="flex flex-col gap-1.5">
        {payload.map((entry) => (
          <div key={entry.name} className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
              <span className="text-xs font-medium text-on-surface">{entry.name}</span>
            </div>
            <span className="text-xs font-bold text-on-surface">
              {formatFinancialUsd(Number(entry.value))}
            </span>
          </div>
        ))}
        <div className="my-1 h-px bg-outline-variant/10" />
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-bold text-on-surface">Total USD</span>
          <span className="text-xs font-extrabold text-primary">{formatFinancialUsd(total)}</span>
        </div>
      </div>
    </div>
  );
}

interface Props {
  dailyVolume: DailyVolumeBucket[];
}

export default function StatsVolumeChart({ dailyVolume }: Props) {
  const [rangeDays, setRangeDays] = useState<VolumeChartRangeDays>(30);

  const { weeklyBars, totalVolumeUsd } = useMemo(
    () => parseContractStatsForStackedBar(dailyVolume, rangeDays),
    [dailyVolume, rangeDays]
  );

  const isEmpty =
    weeklyBars.length === 0 || weeklyBars.every((w) => w.USDC === 0 && w.EURC === 0 && w.XLM === 0);

  return (
    <div className="flex flex-col gap-6 rounded-[24px] border border-outline-variant/15 bg-surface-container-lowest p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="font-headline text-xl font-bold text-on-surface">Historical Volume</h3>
          <p className="text-sm text-on-surface-variant">
            Weekly funded volume by token (USD equivalent, normalized from token units)
          </p>
        </div>
        <div className="flex items-center gap-1 p-1 bg-surface-container rounded-xl self-start">
          {([30, 90] as VolumeChartRangeDays[]).map((days) => (
            <button
              key={days}
              type="button"
              onClick={() => setRangeDays(days)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                rangeDays === days
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {days} days
            </button>
          ))}
        </div>
      </div>

      <div className="relative h-[180px] w-full md:h-[240px]">
        {isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 border-2 border-dashed border-outline-variant/20 rounded-2xl">
            <span className="material-symbols-outlined text-outline-variant/40 text-4xl">
              bar_chart
            </span>
            <p className="text-sm font-medium text-on-surface-variant">
              No volume data in this period
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={weeklyBars} margin={{ top: 10, right: 10, left: -10, bottom: 0 }}>
              <CartesianGrid
                strokeDasharray="3 3"
                vertical={false}
                stroke={GRID_STROKE}
                strokeOpacity={0.2}
              />
              <XAxis
                dataKey="label"
                tick={CHART_TICK_STYLE}
                tickLine={false}
                axisLine={false}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={CHART_TICK_STYLE}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => (v >= 1000 ? `$${(v / 1000).toFixed(0)}k` : `$${v}`)}
              />
              <Tooltip content={<ChartTooltip />} />
              {TOKEN_KEYS.map((symbol) => (
                <Bar
                  key={symbol}
                  dataKey={symbol}
                  name={symbol}
                  stackId="volume"
                  fill={CHART_TOKEN_COLORS[symbol]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="flex items-center justify-between pt-2 border-t border-outline-variant/10">
        <span className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">
          Total volume ({rangeDays} days)
        </span>
        <span className="font-headline text-lg font-bold text-primary">
          {formatFinancialUsd(totalVolumeUsd)}
        </span>
      </div>
      <p className="text-xs text-on-surface-variant">
        USD values use reference rates and are reconciled from the token amounts in each bar.
      </p>
    </div>
  );
}
