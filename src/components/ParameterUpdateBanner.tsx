'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParameterUpdates } from '@/hooks/queries/useParameterUpdates';

/** localStorage key holding the ids of announcements the user has dismissed. */
const STORAGE_KEY = 'iln:dismissed-parameter-updates';

/** Never show more than this many announcement banners at once. */
const MAX_VISIBLE = 2;

function readDismissed(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === 'string')
      : [];
  } catch {
    return [];
  }
}

/**
 * Announces recent protocol parameter changes (#153).
 *
 * - Surfaces parameter changes enacted in the last 48h (via {@link useParameterUpdates}).
 * - Dismissible per event; dismissals persist in localStorage so they don't reappear.
 * - Shows at most {@link MAX_VISIBLE} banners simultaneously.
 * - Links to the governance proposal that enacted each change.
 *
 * Renders nothing when there are no fresh, undismissed announcements.
 */
export default function ParameterUpdateBanner() {
  const { data: updates } = useParameterUpdates();
  const [dismissed, setDismissed] = useState<string[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Read persisted dismissals after mount to avoid SSR/client hydration mismatch.
  useEffect(() => {
    setDismissed(readDismissed());
    setHydrated(true);
  }, []);

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Storage may be unavailable (private mode / quota) — dismissal still
        // applies for this session via state.
      }
      return next;
    });
  };

  if (!hydrated || !updates?.length) return null;

  const visible = updates.filter((update) => !dismissed.includes(update.id)).slice(0, MAX_VISIBLE);

  if (visible.length === 0) return null;

  return (
    <div className="space-y-3 mb-6" data-testid="parameter-update-banners">
      {visible.map((update) => (
        <div
          key={update.id}
          role="status"
          aria-live="polite"
          data-testid="parameter-update-banner"
          className="flex items-start gap-3 rounded-xl border border-blue-500/30 bg-blue-500/10 p-4 text-blue-700 shadow-sm dark:text-blue-300"
        >
          <span
            className="material-symbols-outlined mt-0.5"
            style={{ fontVariationSettings: "'FILL' 1" }}
            aria-hidden="true"
          >
            campaign
          </span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-bold">
              Protocol update: {update.label} changed to {update.newValue}
            </p>
            {/* Only changes enacted by a proposal link to one; direct governance
                parameter writes (e.g. quorum updates) have no proposal (#1057). */}
            {update.proposalId !== null && update.proposalId !== undefined && (
              <Link
                href={`/governance/${update.proposalId}`}
                className="-my-3.5 mt-1 inline-flex items-center py-3.5 text-xs font-medium underline underline-offset-2 opacity-90 hover:opacity-100"
              >
                View governance proposal
              </Link>
            )}
          </div>
          <button
            type="button"
            onClick={() => dismiss(update.id)}
            aria-label={`Dismiss announcement: ${update.label}`}
            data-testid="dismiss-parameter-update"
            className="shrink-0 rounded-lg p-1 transition-colors hover:bg-blue-500/15"
          >
            <span className="material-symbols-outlined text-base" aria-hidden="true">
              close
            </span>
          </button>
        </div>
      ))}
    </div>
  );
}
