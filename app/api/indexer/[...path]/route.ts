import { NextRequest, NextResponse } from 'next/server';
import { IndexerError } from '@/lib/indexer/errors';
import { loadIndexerResource } from '@/lib/indexer/server';
import { checkRateLimit, getClientKey } from '@/lib/rate-limit';
import type { IndexerErrorEnvelope } from '@/lib/indexer/types';

/**
 * The single browser-facing boundary to the indexer. Only allow-listed
 * resources are forwarded; credentials stay on the server and failures are
 * reported as a typed `IndexerErrorEnvelope` without upstream details.
 */
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };
// Several indexer-backed views can load on one page, so allow more than single-resource routes.
const RATE_LIMIT_MAX_REQUESTS = 60;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;

function errorResponse(error: IndexerError, headers: Record<string, string> = {}) {
  const body: IndexerErrorEnvelope = {
    ok: false,
    error: { code: error.code, message: error.message },
  };
  return NextResponse.json(body, { status: error.status, headers: { ...NO_STORE, ...headers } });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path } = await params;

  const rateLimit = checkRateLimit(
    `indexer:${getClientKey(req)}`,
    RATE_LIMIT_MAX_REQUESTS,
    RATE_LIMIT_WINDOW_MS
  );
  if (!rateLimit.allowed) {
    return errorResponse(new IndexerError('rate_limited'), {
      'Retry-After': String(rateLimit.retryAfterSeconds),
    });
  }

  try {
    const envelope = await loadIndexerResource(path, req.nextUrl.searchParams, {
      signal: req.signal,
    });
    return NextResponse.json(envelope, { headers: NO_STORE });
  } catch (err) {
    const error = err instanceof IndexerError ? err : new IndexerError('upstream');
    if (!(err instanceof IndexerError)) {
      console.error('[indexer] unexpected proxy failure:', (err as Error)?.name ?? 'Error');
    }
    return errorResponse(error);
  }
}
