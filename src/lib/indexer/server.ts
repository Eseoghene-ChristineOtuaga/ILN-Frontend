/**
 * Server-only indexer client.
 *
 * This is the single place that knows the upstream indexer URL and API key.
 * It is imported by the `/api/indexer/*` route handler and server code only;
 * browser code must use `src/lib/indexer/client.ts`, which talks to the proxy.
 * `__tests__/indexer-boundary.test.ts` fails if a client module imports it.
 *
 * Configuration (server-only env vars, never `NEXT_PUBLIC_*`):
 *   INDEXER_URL         Base URL of the indexer REST API (required).
 *   INDEXER_API_KEY     Bearer credential sent to the indexer (optional).
 *   INDEXER_TIMEOUT_MS  Upstream timeout in ms (default 8000, clamped 1000–30000).
 *   INDEXER_API_VERSION_POLICY  `strict` (default) or `allow-missing`; see version.ts.
 *   INDEXER_STALE_AFTER_SECONDS Age after which data is flagged stale (default 300).
 */

import { assertNoPublicIndexerSecrets } from './env-guard';
import { IndexerError, indexerErrorCodeForStatus } from './errors';
import { parseStaleAfterMs, readIndexerFreshness } from './freshness';
import { resolveIndexerRequest } from './resources';
import type { IndexerResourceName, IndexerSuccessEnvelope } from './types';
import {
  INDEXER_VERSION_REQUEST_HEADER,
  INDEXER_VERSION_RESPONSE_HEADER,
  negotiateIndexerVersion,
  SUPPORTED_INDEXER_API,
  type IndexerVersionPolicy,
} from './version';

export const DEFAULT_INDEXER_TIMEOUT_MS = 8_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;
/** Upstream bodies larger than this are rejected rather than parsed. */
export const MAX_INDEXER_BODY_BYTES = 2 * 1024 * 1024;

type EnvSource = Record<string, string | undefined>;

export { assertNoPublicIndexerSecrets };

export interface IndexerServerConfig {
  baseUrl: string;
  apiKey: string | null;
  timeoutMs: number;
  versionPolicy: IndexerVersionPolicy;
  staleAfterMs: number;
}

function parseTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_INDEXER_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_INDEXER_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)));
}

function parseVersionPolicy(raw: string | undefined): IndexerVersionPolicy {
  const value = raw?.trim();
  if (!value || value === 'strict') return 'strict';
  if (value === 'allow-missing') return 'allow-missing';
  // A typo must not silently weaken the check.
  throw new IndexerError('not_configured');
}

let warnedDeprecatedUrl = false;

export function readIndexerServerConfig(source: EnvSource = process.env): IndexerServerConfig {
  try {
    assertNoPublicIndexerSecrets(source);
  } catch (err) {
    // The message names the variables (never their values); keep it server-side.
    console.error('[indexer]', (err as Error).message);
    throw new IndexerError('not_configured');
  }

  let rawUrl = source.INDEXER_URL?.trim();
  if (!rawUrl && source.NEXT_PUBLIC_INDEXER_API_URL?.trim()) {
    // Deprecated: the browser used to call the indexer directly with this value.
    rawUrl = source.NEXT_PUBLIC_INDEXER_API_URL.trim();
    if (!warnedDeprecatedUrl) {
      warnedDeprecatedUrl = true;
      console.warn('[indexer] NEXT_PUBLIC_INDEXER_API_URL is deprecated; set INDEXER_URL instead.');
    }
  }
  if (!rawUrl) throw new IndexerError('not_configured');

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new IndexerError('not_configured');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new IndexerError('not_configured');
  }

  return {
    baseUrl: parsed.toString().replace(/\/+$/, ''),
    apiKey: source.INDEXER_API_KEY?.trim() || null,
    timeoutMs: parseTimeout(source.INDEXER_TIMEOUT_MS),
    versionPolicy: parseVersionPolicy(source.INDEXER_API_VERSION_POLICY),
    staleAfterMs: parseStaleAfterMs(source.INDEXER_STALE_AFTER_SECONDS),
  };
}

/** Replace every occurrence of the given secrets in `text`. */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | null | undefined>) {
  return secrets.reduce<string>(
    (out, secret) => (secret ? out.split(secret).join('[redacted]') : out),
    text
  );
}

export interface IndexerRequestDeps {
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}

export interface IndexerUpstreamResponse {
  body: unknown;
  headers: Headers;
}

/** Perform an authenticated, time-limited GET against the indexer. */
export async function requestIndexer(
  upstreamPath: string,
  config: IndexerServerConfig,
  { fetchImpl = fetch, signal }: IndexerRequestDeps = {}
): Promise<IndexerUpstreamResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const onCallerAbort = () => controller.abort();
  signal?.addEventListener('abort', onCallerAbort, { once: true });

  const headers: Record<string, string> = {
    Accept: 'application/json',
    [INDEXER_VERSION_REQUEST_HEADER]: `${SUPPORTED_INDEXER_API.major}`,
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  try {
    let response: Response;
    try {
      response = await fetchImpl(`${config.baseUrl}${upstreamPath}`, {
        method: 'GET',
        headers,
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) throw new IndexerError('timeout');
      console.error(
        '[indexer] request failed:',
        redactSecrets(String(err), [config.apiKey, config.baseUrl])
      );
      throw new IndexerError('network');
    }

    if (!response.ok) {
      throw new IndexerError(indexerErrorCodeForStatus(response.status));
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength > MAX_INDEXER_BODY_BYTES) {
      throw new IndexerError('upstream', 'The indexer response was too large.');
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new IndexerError(timedOut ? 'timeout' : 'network');
    }
    if (text.length > MAX_INDEXER_BODY_BYTES) {
      throw new IndexerError('upstream', 'The indexer response was too large.');
    }

    try {
      return { body: JSON.parse(text) as unknown, headers: response.headers };
    } catch {
      throw new IndexerError('schema', 'The indexer returned a response that is not valid JSON.');
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Resolve, fetch, and validate an allow-listed indexer resource.
 * Throws `IndexerError` for every failure mode.
 */
export async function loadIndexerResource(
  segments: readonly string[],
  searchParams: URLSearchParams,
  deps: IndexerRequestDeps & { env?: EnvSource } = {}
): Promise<IndexerSuccessEnvelope<unknown[]>> {
  const { resource, upstreamPath } = resolveIndexerRequest(segments, searchParams);
  const config = readIndexerServerConfig(deps.env);
  const { body, headers } = await requestIndexer(upstreamPath, config, deps);
  // Check the contract version before parsing so drift fails as a version error.
  const apiVersion = negotiateIndexerVersion(
    headers.get(INDEXER_VERSION_RESPONSE_HEADER),
    config.versionPolicy
  );
  const { records, dropped } = resource.parse(body);

  return {
    ok: true,
    resource: resource.name as IndexerResourceName,
    data: records,
    meta: {
      apiVersion,
      droppedRecords: dropped,
      freshness: readIndexerFreshness(headers, config.staleAfterMs),
    },
  };
}
