'use client';

import React, { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { formatAddress, formatRelativeTime, formatUSDC } from '@/utils/format';
import { fetchInvoiceEvents } from '@/lib/indexer';
import IndexerUnavailableNotice, {
  shouldUseDevMockFallback,
  type IndexerNoticeStatus,
} from '@/components/IndexerUnavailableNotice';
import DataSourceCaption from '@/components/DataSourceCaption';
import {
  fetchInvoiceEvents,
  classifyIndexerClientError,
  isAbortError,
  type RawInvoiceEvent,
} from '@/lib/indexer-client';

type InvoiceEventType =
  | 'submitted'
  | 'funded'
  | 'partially_paid'
  | 'paid'
  | 'defaulted'
  | 'cancelled'
  | 'dispute_raised'
  | 'dispute_resolved'
  | 'unknown';

interface InvoiceEvent {
  type: InvoiceEventType;
  timestamp: number;
  actor?: string;
  data?: Record<string, unknown>;
  raw: RawInvoiceEvent;
}

interface ActivityFeedProps {
  invoiceId: bigint;
}

const EVENT_TYPE_MAP: Record<string, InvoiceEventType> = {
  submitted: 'submitted',
  invoice_submitted: 'submitted',
  funded: 'funded',
  invoice_funded: 'funded',
  paid: 'paid',
  invoice_paid: 'paid',
  partially_paid: 'partially_paid',
  invoice_partially_paid: 'partially_paid',
  partial_payment: 'partially_paid',
  defaulted: 'defaulted',
  invoice_defaulted: 'defaulted',
  cancelled: 'cancelled',
  invoice_cancelled: 'cancelled',
  dispute_raised: 'dispute_raised',
  invoice_disputed: 'dispute_raised',
  dispute_resolved: 'dispute_resolved',
  invoice_resolved: 'dispute_resolved',
};

const EVENT_CONFIG: Record<
  InvoiceEventType,
  {
    icon: string;
    color: string;
    bgColor: string;
    description: (event: InvoiceEvent) => React.ReactNode;
  }
> = {
  submitted: {
    icon: 'publish',
    color: 'text-blue-500',
    bgColor: 'bg-blue-500/10',
    description: (event) => (
      <>
        Invoice submitted by{' '}
        {event.actor ? (
          <Link href={`/profile/${event.actor}`} className="font-mono text-primary hover:underline">
            {formatAddress(event.actor)}
          </Link>
        ) : (
          'Unknown actor'
        )}
      </>
    ),
  },
  funded: {
    icon: 'payments',
    color: 'text-emerald-500',
    bgColor: 'bg-emerald-500/10',
    description: (event) => {
      const amount = formatUSDCValue(event.data?.amount);
      return (
        <>
          Invoice funded by{' '}
          {event.actor ? (
            <Link
              href={`/profile/${event.actor}`}
              className="font-mono text-primary hover:underline"
            >
              {formatAddress(event.actor)}
            </Link>
          ) : (
            'Unknown actor'
          )}
          {amount ? ` for ${amount}` : null}
        </>
      );
    },
  },
  partially_paid: {
    icon: 'payment',
    color: 'text-sky-500',
    bgColor: 'bg-sky-500/10',
    description: (event) => {
      const amount = formatUSDCValue(event.data?.amount);
      return (
        <>
          Partial payment by{' '}
          {event.actor ? (
            <Link
              href={`/profile/${event.actor}`}
              className="font-mono text-primary hover:underline"
            >
              {formatAddress(event.actor)}
            </Link>
          ) : (
            'Unknown actor'
          )}
          {amount ? ` of ${amount}` : null}
        </>
      );
    },
  },
  paid: {
    icon: 'check_circle',
    color: 'text-green-500',
    bgColor: 'bg-green-500/10',
    description: (event) => (
      <>
        Invoice paid by{' '}
        {event.actor ? (
          <Link href={`/profile/${event.actor}`} className="font-mono text-primary hover:underline">
            {formatAddress(event.actor)}
          </Link>
        ) : (
          'Unknown actor'
        )}
      </>
    ),
  },
  defaulted: {
    icon: 'report_problem',
    color: 'text-amber-500',
    bgColor: 'bg-amber-500/10',
    description: (event) => {
      const amount = formatUSDCValue(event.data?.amount);
      return (
        <>
          Invoice defaulted
          {event.actor ? (
            <>
              {' '}
              by{' '}
              <Link
                href={`/profile/${event.actor}`}
                className="font-mono text-primary hover:underline"
              >
                {formatAddress(event.actor)}
              </Link>
            </>
          ) : (
            ''
          )}
          {amount ? ` with claimed amount ${amount}` : null}
        </>
      );
    },
  },
  cancelled: {
    icon: 'cancel',
    color: 'text-red-500',
    bgColor: 'bg-red-500/10',
    description: (event) => (
      <>
        Invoice cancelled by{' '}
        {event.actor ? (
          <Link href={`/profile/${event.actor}`} className="font-mono text-primary hover:underline">
            {formatAddress(event.actor)}
          </Link>
        ) : (
          'Unknown actor'
        )}
      </>
    ),
  },
  dispute_raised: {
    icon: 'gavel',
    color: 'text-purple-500',
    bgColor: 'bg-purple-500/10',
    description: (event) => (
      <>
        Dispute raised by{' '}
        {event.actor ? (
          <Link href={`/profile/${event.actor}`} className="font-mono text-primary hover:underline">
            {formatAddress(event.actor)}
          </Link>
        ) : (
          'Unknown actor'
        )}
      </>
    ),
  },
  dispute_resolved: {
    icon: 'task_alt',
    color: 'text-violet-500',
    bgColor: 'bg-violet-500/10',
    description: (event) => (
      <>
        Dispute resolved by{' '}
        {event.actor ? (
          <Link href={`/profile/${event.actor}`} className="font-mono text-primary hover:underline">
            {formatAddress(event.actor)}
          </Link>
        ) : (
          'Unknown actor'
        )}
      </>
    ),
  },
  unknown: {
    icon: 'help_outline',
    color: 'text-on-surface-variant',
    bgColor: 'bg-surface-container-high',
    description: () => 'Unknown activity occurred',
  },
};

function formatUSDCValue(value: unknown): string | null {
  try {
    if (value === undefined || value === null) return null;
    return formatUSDC(BigInt(value as string | number));
  } catch {
    return null;
  }
}

function normalizeEventType(value?: string): InvoiceEventType {
  if (!value) return 'unknown';
  return EVENT_TYPE_MAP[value.toString().toLowerCase()] ?? 'unknown';
}

function parseInvoiceEvent(raw: RawInvoiceEvent): InvoiceEvent {
  const resolvedTimestamp = raw.timestamp
    ? typeof raw.timestamp === 'string'
      ? Date.parse(raw.timestamp)
      : Number(raw.timestamp)
    : Date.now();
  return {
    type: normalizeEventType(raw.type),
    timestamp:
      Number.isFinite(resolvedTimestamp) && !Number.isNaN(resolvedTimestamp)
        ? resolvedTimestamp
        : Date.now(),
    actor: raw.actor,
    data: raw.data,
    raw,
  };
}

function formatEventTypeLabel(type: InvoiceEventType) {
  return type.replace(/_/g, ' ').replace(/\b\w/g, (match) => match.toUpperCase());
}

export default function ActivityFeed({ invoiceId }: ActivityFeedProps) {
  const [events, setEvents] = useState<InvoiceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<IndexerNoticeStatus>('unavailable');
  const [expandedEvents, setExpandedEvents] = useState<Record<number, boolean>>({});

  const fetchEvents = useCallback(async (signal?: AbortSignal) => {
    try {
      setLoading(true);
      setError(null);
      const rawEvents = await fetchInvoiceEvents(invoiceId, { signal });
      setEvents(rawEvents.map(parseInvoiceEvent));
    } catch (err) {
      if (isAbortError(err)) {
        return;
      }
      console.error(err);
      setEvents([]);
      setError('Unable to load activity feed.');
      const boundary = classifyIndexerClientError(err);
      setErrorStatus(
        boundary === 'rate-limited' || boundary === 'unauthorized' || boundary === 'malformed'
          ? boundary
          : 'unavailable'
      );

      // Only substitute demonstration data in development. In every other
      // environment (including production) show the honest "temporarily
      // unavailable" state rather than fabricating an audit trail.
      if (shouldUseDevMockFallback()) {
        setEvents([
          {
            type: 'submitted',
            timestamp: Date.now() - 86400000 * 2,
            actor: 'GABC12345678901234567890123456789012345678901234567890123456',
            raw: {
              type: 'submitted',
              timestamp: Date.now() - 86400000 * 2,
              actor: 'GABC12345678901234567890123456789012345678901234567890123456',
            },
          },
          {
            type: 'funded',
            timestamp: Date.now() - 86400000,
            actor: 'GDEF5678901234567890123456789012345678901234567890123456',
            data: { amount: '1000000000' },
            raw: {
              type: 'funded',
              timestamp: Date.now() - 86400000,
              actor: 'GDEF5678901234567890123456789012345678901234567890123456',
              data: { amount: '1000000000' },
            },
          },
        ]);
        setError(null);
      }
    } finally {
      setLoading(false);
    }
  }, [invoiceId]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchEvents(controller.signal);
    return () => {
      controller.abort();
    };
  }, [fetchEvents]);

  const sortedEvents = useMemo(
    () => [...events].sort((a, b) => b.timestamp - a.timestamp),
    [events]
  );

  const toggleRawData = (index: number) => {
    setExpandedEvents((current) => ({
      ...current,
      [index]: !current[index],
    }));
  };

  if (loading) {
    return (
      <section className="mt-8 animate-pulse rounded-3xl border border-outline-variant/15 bg-surface-container-lowest p-6 shadow-xl">
        <div className="h-4 w-48 rounded-full bg-surface-container-lowest/70" />
        <div className="mt-6 space-y-4">
          <div className="h-28 rounded-3xl bg-surface-container-lowest" />
          <div className="h-28 rounded-3xl bg-surface-container-lowest" />
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="mt-8">
        <p className="mb-2 text-xs font-bold uppercase tracking-widest text-primary">
          Event History
        </p>
        <IndexerUnavailableNotice
          dataSource="The invoice activity feed"
          status={errorStatus}
          onRetry={() => {
            setError(null);
            setEvents([]);
            void fetchEvents();
          }}
        />
      </section>
    );
  }

  if (events.length === 0) {
    return (
      <section className="mt-8 rounded-3xl border border-outline-variant/15 bg-surface-container-lowest p-8 text-center text-on-surface-variant">
        <p className="text-xs font-bold uppercase tracking-widest text-primary">Event History</p>
        <p className="mt-4 text-sm">No activity yet for this invoice.</p>
      </section>
    );
  }

  return (
    <section className="mt-8 rounded-3xl border border-outline-variant/15 bg-surface-container-lowest p-6 shadow-xl">
      <div className="mb-6">
        <p className="text-xs font-bold uppercase tracking-widest text-primary">Event History</p>
        <h2 className="mt-2 text-xl font-semibold text-on-surface">Invoice audit trail</h2>
        <DataSourceCaption metric="invoice-activity" className="mt-1" />
      </div>

      <div className="space-y-4 relative">
        <div className="absolute left-[24px] top-4 bottom-4 w-px bg-outline-variant/10 hidden sm:block" />

        {sortedEvents.map((event, idx) => {
          const config = EVENT_CONFIG[event.type] || EVENT_CONFIG.unknown;
          const rawJson = JSON.stringify(event.raw, null, 2);

          return (
            <article
              key={idx}
              className="relative rounded-3xl border border-outline-variant/10 bg-white p-4 shadow-sm transition-all hover:shadow-md"
            >
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-4">
                  <div
                    className={`flex h-12 w-12 items-center justify-center rounded-2xl border border-outline-variant/10 ${config.bgColor}`}
                  >
                    <span
                      className={`material-symbols-outlined text-2xl ${config.color}`}
                      style={{ fontVariationSettings: "'FILL' 1" }}
                    >
                      {config.icon}
                    </span>
                  </div>
                  <div className="space-y-2">
                    <p className="text-sm font-medium text-on-surface">
                      {config.description(event)}
                    </p>
                    <div className="flex flex-wrap items-center gap-3 text-[11px] uppercase tracking-wider text-on-surface-variant">
                      <span className="font-bold text-primary">
                        {formatEventTypeLabel(event.type)}
                      </span>
                      {event.actor ? (
                        <Link
                          href={`/profile/${event.actor}`}
                          className="font-mono text-primary hover:underline"
                        >
                          {formatAddress(event.actor)}
                        </Link>
                      ) : (
                        <span className="font-mono">Unknown actor</span>
                      )}
                      {formatUSDCValue(event.data?.amount) ? (
                        <span>{formatUSDCValue(event.data?.amount)}</span>
                      ) : null}
                    </div>
                  </div>
                </div>

                <div className="flex flex-col items-start gap-2 sm:items-end">
                  <span
                    className="rounded-full bg-surface-container-low px-3 py-1.5 text-[12px] text-on-surface-variant"
                    title={new Date(event.timestamp).toLocaleString()}
                  >
                    {formatRelativeTime(event.timestamp)}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggleRawData(idx)}
                    className="text-xs text-primary hover:underline"
                    aria-expanded={Boolean(expandedEvents[idx])}
                  >
                    {expandedEvents[idx] ? 'Hide raw event data' : 'Show raw event data'}
                  </button>
                </div>
              </div>

              {expandedEvents[idx] ? (
                <pre className="mt-4 overflow-x-auto rounded-2xl bg-surface-container-lowest p-4 text-xs leading-relaxed text-on-surface-variant">
                  {rawJson}
                </pre>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
