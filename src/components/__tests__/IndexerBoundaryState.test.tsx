/**
 * @file IndexerBoundaryState.test.tsx
 *
 * Covers the reusable indexer boundary states (#1155): the typed classifier
 * helpers and the presentational renderer.
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { IndexerBoundaryState } from '../IndexerBoundaryState';
import {
  classifyIndexerError,
  classifyIndexerHttpStatus,
  classifyIndexerPayload,
} from '@/lib/indexer-boundary';

describe('indexer boundary classifiers', () => {
  it('classifies 401/403 as unauthorized', () => {
    expect(classifyIndexerHttpStatus(401)).toBe('unauthorized');
    expect(classifyIndexerHttpStatus(403)).toBe('unauthorized');
  });

  it('classifies 400/422 as malformed', () => {
    expect(classifyIndexerHttpStatus(400)).toBe('malformed');
    expect(classifyIndexerHttpStatus(422)).toBe('malformed');
  });

  it('classifies 429 as rate-limited', () => {
    expect(classifyIndexerHttpStatus(429)).toBe('rate-limited');
  });

  it('classifies 500/503 as unavailable', () => {
    expect(classifyIndexerHttpStatus(500)).toBe('unavailable');
    expect(classifyIndexerHttpStatus(503)).toBe('unavailable');
  });

  it('returns null for healthy statuses', () => {
    expect(classifyIndexerHttpStatus(200)).toBeNull();
    expect(classifyIndexerHttpStatus(204)).toBeNull();
  });

  it('classifies thrown errors as malformed', () => {
    expect(classifyIndexerError(new Error('network down'))).toBe('malformed');
    expect(classifyIndexerError(undefined)).toBe('malformed');
  });

  it('classifies an empty array as empty and a populated array as healthy', () => {
    expect(classifyIndexerPayload([])).toBe('empty');
    expect(classifyIndexerPayload([{ id: 1 }])).toBeNull();
  });

  it('classifies a non-array payload as malformed', () => {
    expect(classifyIndexerPayload({ unexpected: true })).toBe('malformed');
    expect(classifyIndexerPayload(null)).toBe('malformed');
  });
});

describe('IndexerBoundaryState', () => {
  it('renders an accessible status role for loading', () => {
    render(<IndexerBoundaryState status="loading" />);
    expect(screen.getByRole('status')).toHaveAttribute('data-testid', 'indexer-boundary-loading');
    expect(screen.getByText('Loading')).toBeInTheDocument();
  });

  it('renders an assertive alert role for unauthorized', () => {
    render(<IndexerBoundaryState status="unauthorized" />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-testid', 'indexer-boundary-unauthorized');
    expect(alert).toHaveAttribute('aria-live', 'assertive');
    expect(screen.getByText('Not authorized')).toBeInTheDocument();
  });

  it('renders the malformed state with its message', () => {
    render(<IndexerBoundaryState status="malformed" />);
    expect(screen.getByText('Unexpected response')).toBeInTheDocument();
  });

  it('renders the empty state', () => {
    render(<IndexerBoundaryState status="empty" />);
    expect(screen.getByText('No data yet')).toBeInTheDocument();
  });

  it('renders the stale state with a detail line', () => {
    render(<IndexerBoundaryState status="stale" detail="Last updated 2 minutes ago" />);
    expect(screen.getByText('Showing stale data')).toBeInTheDocument();
    expect(screen.getByText('Last updated 2 minutes ago')).toBeInTheDocument();
  });

  it('invokes onRetry from the retry button', () => {
    const onRetry = vi.fn();
    render(<IndexerBoundaryState status="malformed" onRetry={onRetry} />);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('omits the retry button when no handler is supplied', () => {
    render(<IndexerBoundaryState status="empty" />);
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
