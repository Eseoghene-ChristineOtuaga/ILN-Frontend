'use client';

import { GovernanceAction, GOVERNANCE_INTEGRATION_STATUS } from '@/utils/governance';

/**
 * Warns when a governance action will not reach the chain.
 *
 * Two distinct non-live states (#1044, #1045):
 *
 * - `Stubbed` — still mock-backed; the action does nothing on-chain.
 * - `Unconfigured` — the real signed-transaction path is implemented, but no
 *   governance contract is configured, so the action fails up front instead of
 *   silently pretending to succeed. Saying so plainly matters more than
 *   hiding the banner once the code became real.
 */
const BANNER_COPY: Record<'Stubbed' | 'Unconfigured', { heading: string; detail: string }> = {
  Stubbed: {
    heading: 'Not yet live',
    detail: 'is currently backed by a mock and will not execute on-chain yet.',
  },
  Unconfigured: {
    heading: 'Contract not configured',
    detail:
      'runs as a real on-chain transaction, but no governance contract is configured for this ' +
      'deployment, so it cannot be submitted yet.',
  },
};

export default function GovernanceMockStatusBanner({ action }: { action: GovernanceAction }) {
  const status = GOVERNANCE_INTEGRATION_STATUS[action];

  if (status.status === 'Real') {
    return null;
  }

  const copy = BANNER_COPY[status.status];

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-4 flex items-start gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 shadow-sm dark:text-amber-100"
    >
      <span className="material-symbols-outlined text-base text-amber-600" aria-hidden="true">
        warning
      </span>
      <div className="flex flex-col gap-0.5">
        <span className="font-bold uppercase tracking-[0.12em] text-amber-700 dark:text-amber-200">
          {copy.heading}
        </span>
        <span className="text-amber-800/90 dark:text-amber-100/90">
          {status.label} {copy.detail}
        </span>
      </div>
    </div>
  );
}
