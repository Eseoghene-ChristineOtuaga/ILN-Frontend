'use client';

import React, { useCallback, useState, useEffect, useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  type TooltipProps,
} from 'recharts';
import { transformFundingData } from '@/utils/funding';
import { fetchFunding } from '@/lib/indexer';
import IndexerUnavailableNotice, {
  shouldUseDevMockFallback,
  type IndexerNoticeStatus,
} from '@/components/IndexerUnavailableNotice';
import DataSourceCaption from '@/components/DataSourceCaption';
import {
  fetchFundingAnalytics,
  classifyIndexerClientError,
  isAbortError,
} from '@/lib/indexer-client';

// ─── Types ───────────────────────────────────────────────────────────────────

export type TimeRange = '7D' | '30D' | '90D' | 'All';

export interface TokenFunding {
  symbol: string;
  amount: number; // Whole unit amount
  color: string;
}

export interface DailyFundingBucket {
  date: string;
  label: string;
  total_usdc_equiv: number;
  invoices_funded: number;
  tokens: TokenFunding[];
}

// ─── Constants ────────────────────────────────────────────────────────────────

const TIME_RANGES: TimeRange[] = ['7D', '30D', '90D', 'All'];

const TOKEN_COLORS: Record<string, string> = {
  USDC: 'var(--color-primary, #008080)',
  EURC: 'var(--color-secondary, #2e7d32)',
  XLM: 'var(--color-tertiary, #d32f2f)',
};

const CHART_TICK_STYLE = {
  fill: 'var(--color-on-surface-variant, #94a3b8)',
  fontSize: 11,
  fontFamily: 'inherit',
};

const GRID_STROKE = 'var(--color-outline-variant, #334155)';

// ─── Mock Data Generator ─────────────────────────────────────────────────────

function generateMockFunding(range: TimeRange): DailyFundingBucket[] {
  const buckets: DailyFundingBucket[] = [];
  const now = new Date();
  let days = 30;
  if (range === '7D') days = 7;
  else if (range === '90D') days = 90;
  else if (range === 'All') days = 180;

  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    const usdc = Math.floor(Math.random() * 10_000) + 2_000;
    const eurc = Math.floor(Math.random() * 5_000) + 1_000;
    const xlm = Math.floor(Math.random() * 2_000) + 500;

    buckets.push({
      date: d.toISOString().slice(0, 10),
      label,
      total_usdc_equiv: usdc + eurc * 1.08 + xlm * 0.12, // rough estimation
      invoices_funded: Math.floor(Math.random() * 5) + 1,
      tokens: [
        { symbol: 'USDC', amount: usdc, color: TOKEN_COLORS.USDC },
        { symbol: 'EURC', amount: eurc, color: TOKEN_COLORS.EURC },
        { symbol: 'XLM', amount: xlm, color: TOKEN_COLORS.XLM },
      ],
    });
  }
  return buckets;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;

  // We need to access the original data to show number of invoices
  const data = payload[0].payload as DailyFundingBucket;
  const total = payload.reduce((sum, entry) => sum + (entry.value as number), 0);

  return (
    <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-4 py-3 shadow-xl">
      <p className="mb-2 text-[11px] font-bold uppercase tracking-widest text-on-surface-variant">
        {label}
      </p>
      <div className="flex flex-col gap-1.5">
        {payload.map((entry) => (
          <div key={entry.name} className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
              <span className="text-xs font-medium text-on-surface">{entry.name}</span>
            </div>
            <span className="text-xs font-bold text-on-surface">
              ${Number(entry.value).toLocaleString()}
            </span>
          </div>
        ))}
        <div className="my-1 h-px bg-outline-variant/10" />
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-bold text-on-surface">Total Funding</span>
          <span className="text-xs font-extrabold text-primary">${total.toLocaleString()}</span>
        </div>
        <p className="mt-1 text-[10px] text-on-surface-variant italic">
          {data.invoices_funded} invoice{data.invoices_funded !== 1 ? 's' : ''} funded
        </p>
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function FundingChart() {
  const [range, setRange] = useState<TimeRange>('30D');
  const [data, setData] = useState<DailyFundingBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [errorStatus, setErrorStatus] = useState<IndexerNoticeStatus>('unavailable');
  const [requestId, setRequestId] = useState(0);

  const fetchData = useCallback(async (selectedRange: TimeRange, signal?: AbortSignal) => {
    setLoading(true);
    setUnavailable(false);
    try {
      const dailyData = await fetchFundingAnalytics(selectedRange.toLowerCase(), { signal });
      setData(dailyData);
    } catch (err) {
      if (isAbortError(err)) {
        return;
      }
      // Only substitute demo data in development; otherwise show an honest
      // "temporarily unavailable" state instead of fabricating volume.
      if (shouldUseDevMockFallback()) {
        setData(generateMockFunding(selectedRange));
      } else {
        const boundary = classifyIndexerClientError(err);
        setErrorStatus(
          boundary === 'rate-limited' || boundary === 'unauthorized' || boundary === 'malformed'
            ? boundary
            : 'unavailable'
        );
        setData([]);
        setUnavailable(true);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchData(range, controller.signal);
    return () => {
      controller.abort();
    };
  }, [range, requestId, fetchData]);

  const transformedData = useMemo(() => transformFundingData(data), [data]);

  const isEmpty = !loading && data.length === 0 && !unavailable;

  return (
    <div className="flex flex-col gap-6 rounded-[24px] border border-outline-variant/15 bg-surface-container-lowest p-6 shadow-sm">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="font-headline text-xl font-bold text-on-surface">LP Funding History</h3>
          <p className="text-sm text-on-surface-variant">Daily volume across supported tokens</p>
          <DataSourceCaption metric="funding-history" />
        </div>

        {/* Time Range Selector */}
        <div className="flex items-center gap-1 p-1 bg-surface-container rounded-xl self-start">
          {TIME_RANGES.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                range === r
                  ? 'bg-primary text-white shadow-sm'
                  : 'text-on-surface-variant hover:text-on-surface'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="relative h-[180px] w-full md:h-[240px]">
        {loading && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-surface-container-lowest/50 backdrop-blur-[1px]">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-outline-variant/30 border-t-primary" />
          </div>
        )}

        {unavailable ? (
          <div className="flex h-full items-center">
            <IndexerUnavailableNotice
              dataSource="Funding history"
              status={errorStatus}
              onRetry={() => setRequestId((id) => id + 1)}
            />
          </div>
        ) : isEmpty ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 border-2 border-dashed border-outline-variant/20 rounded-2xl">
            <span className="material-symbols-outlined text-outline-variant/40 text-4xl">
              bar_chart
            </span>
            <p className="text-sm font-medium text-on-surface-variant">
              No funding activity in this period
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={transformedData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
              <defs>
                {Object.entries(TOKEN_COLORS).map(([symbol, color]) => (
                  <linearGradient
                    key={`grad-${symbol}`}
                    id={`grad-${symbol}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor={color} stopOpacity={0.2} />
                    <stop offset="95%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                ))}
              </defs>
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
                interval={range === '7D' ? 0 : 'preserveStartEnd'}
              />
              <YAxis
                tick={CHART_TICK_STYLE}
                tickLine={false}
                axisLine={false}
                tickFormatter={(v: number) => (v >= 1000 ? `${v / 1000}k` : v.toString())}
              />
              <Tooltip content={<ChartTooltip />} />

              <Area
                type="monotone"
                dataKey="USDC"
                stackId="1"
                stroke={TOKEN_COLORS.USDC}
                fill={`url(#grad-USDC)`}
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="EURC"
                stackId="1"
                stroke={TOKEN_COLORS.EURC}
                fill={`url(#grad-EURC)`}
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="XLM"
                stackId="1"
                stroke={TOKEN_COLORS.XLM}
                fill={`url(#grad-XLM)`}
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
