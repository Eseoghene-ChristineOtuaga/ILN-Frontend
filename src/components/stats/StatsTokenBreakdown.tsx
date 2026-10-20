'use client';

import React from 'react';
import type { TokenVolume } from '@/utils/contract-stats';
import { formatFinancialUsd } from '@/utils/financial-display';

const TOKEN_ICONS: Record<string, string> = {
  USDC: 'currency_exchange',
  EURC: 'euro',
  XLM: 'star',
};

interface Props {
  tokens: TokenVolume[];
  totalUsd: number;
}

export default function StatsTokenBreakdown({ tokens, totalUsd }: Props) {
  return (
    <div className="flex flex-col gap-4 rounded-[24px] border border-outline-variant/15 bg-surface-container-lowest p-6 shadow-sm">
      <div>
        <h3 className="font-headline text-xl font-bold text-on-surface">Token Breakdown</h3>
        <p className="text-sm text-on-surface-variant">Volume distribution by asset</p>
      </div>

      <div className="flex flex-col gap-3">
        {tokens.map((token) => (
          <div
            key={token.symbol}
            className="flex items-center gap-4 rounded-2xl border border-outline-variant/10 bg-surface-container p-4"
          >
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
              style={{ backgroundColor: `${token.color}20` }}
            >
              <span
                className="material-symbols-outlined text-xl"
                style={{ color: token.color, fontVariationSettings: "'FILL' 1" }}
              >
                {TOKEN_ICONS[token.symbol] ?? 'token'}
              </span>
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-sm font-bold text-on-surface">{token.symbol}</span>
                <span className="text-xs text-on-surface-variant font-medium">
                  {token.percentage.toFixed(1)}%
                </span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-surface-container-high overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${token.percentage}%`, backgroundColor: token.color }}
                />
              </div>
            </div>

            <div className="text-right shrink-0">
              <p className="text-sm font-bold text-on-surface">
                {token.amount_raw >= 1_000_000
                  ? `${(token.amount_raw / 1_000_000).toFixed(2)}M`
                  : token.amount_raw >= 1_000
                    ? `${(token.amount_raw / 1_000).toFixed(1)}K`
                    : token.amount_raw.toLocaleString('en-US', { maximumFractionDigits: 2 })}{' '}
                {token.symbol}
              </p>
              <p className="text-xs text-on-surface-variant">
                ≈ {formatFinancialUsd(token.amount_usd)}
              </p>
            </div>
          </div>
        ))}

        {tokens.length === 0 && (
          <div className="flex flex-col items-center justify-center gap-2 py-10 border-2 border-dashed border-outline-variant/20 rounded-2xl">
            <span className="material-symbols-outlined text-outline-variant/40 text-4xl">
              token
            </span>
            <p className="text-sm font-medium text-on-surface-variant">No token data available</p>
          </div>
        )}
      </div>

      {totalUsd > 0 && (
        <div className="flex items-center justify-between pt-2 border-t border-outline-variant/10">
          <span className="text-xs font-bold uppercase tracking-widest text-on-surface-variant">
            Total
          </span>
          <span className="font-headline text-lg font-bold text-primary">
            $
            {totalUsd >= 1_000_000
              ? `${(totalUsd / 1_000_000).toFixed(2)}M`
              : totalUsd >= 1_000
                ? `${(totalUsd / 1_000).toFixed(1)}K`
                : totalUsd.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </span>
        </div>
      )}
    </div>
  );
}
