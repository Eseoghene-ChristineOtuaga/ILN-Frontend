/**
 * Screen-reader indexer error states gate (#1129).
 *
 * `IndexerBoundaryState` and `IndexerUnavailableNotice` are the two
 * components every indexer-backed surface falls back to when the indexer
 * is unreachable, stale, empty, unauthorized, or returns something
 * malformed (see src/lib/indexer-boundary.ts and docs/indexer-downtime.md).
 * `IndexerBoundaryState.test.tsx` already asserts each state's role/
 * aria-live attribute values, but neither component has ever been run
 * through axe, and `IndexerUnavailableNotice` has no test coverage at all.
 */
import { render, screen } from '@testing-library/react';
import { axe } from 'jest-axe';
import { describe, it, expect, vi } from 'vitest';
import { IndexerBoundaryState } from '@/components/IndexerBoundaryState';
import IndexerUnavailableNotice from '@/components/IndexerUnavailableNotice';
import type { IndexerBoundaryStatus } from '@/lib/indexer-boundary';

const ALL_STATUSES: IndexerBoundaryStatus[] = [
  'loading',
  'stale',
  'empty',
  'unauthorized',
  'malformed',
  'unavailable',
  'rate-limited',
];

describe('IndexerBoundaryState accessibility (#1129)', () => {
  it.each(ALL_STATUSES)('status=%s has no detectable a11y violations', async (status) => {
    const { container } = render(<IndexerBoundaryState status={status} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it.each(ALL_STATUSES)('status=%s with a retry handler has no detectable a11y violations', async (status) => {
    const { container } = render(<IndexerBoundaryState status={status} onRetry={vi.fn()} />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('announces non-urgent states politely and urgent states assertively', () => {
    render(<IndexerBoundaryState status="loading" />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('announces the malformed state assertively, as an alert', () => {
    render(<IndexerBoundaryState status="malformed" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
  });
});

describe('IndexerUnavailableNotice accessibility (#1129)', () => {
  it('has no detectable a11y violations', async () => {
    const { container } = render(<IndexerUnavailableNotice dataSource="the activity feed" />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('has no detectable a11y violations with a retry affordance', async () => {
    const { container } = render(
      <IndexerUnavailableNotice dataSource="the activity feed" onRetry={vi.fn()} retrying={false} />
    );
    expect(await axe(container)).toHaveNoViolations();
  });

  it('is announced as an alert so a screen reader interrupts to report the outage', () => {
    render(<IndexerUnavailableNotice dataSource="the leaderboard" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent(/temporarily unavailable/i);
  });

  it('labels the retry button accessibly while a retry is in flight', () => {
    render(
      <IndexerUnavailableNotice dataSource="the leaderboard" onRetry={vi.fn()} retrying={true} />
    );
    const retryButton = screen.getByRole('button');
    expect(retryButton).toHaveAccessibleName(/retrying/i);
    expect(retryButton).toBeDisabled();
  });
});
