/**
 * Typed error contract for the indexer boundary.
 *
 * Shared by the server proxy (`app/api/indexer/[...path]/route.ts`) and the
 * browser client (`src/lib/indexer/client.ts`). Messages are user-safe: they
 * never contain upstream URLs, headers, response bodies, or credentials.
 */

export type IndexerErrorCode =
  | 'not_configured'
  | 'bad_request'
  | 'unknown_resource'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'upstream'
  | 'schema'
  | 'version_mismatch';

/** HTTP status the proxy responds with for each error code. */
export const INDEXER_ERROR_STATUS: Record<IndexerErrorCode, number> = {
  not_configured: 503,
  bad_request: 400,
  unknown_resource: 404,
  unauthorized: 502,
  forbidden: 502,
  not_found: 404,
  rate_limited: 429,
  timeout: 504,
  network: 502,
  upstream: 502,
  schema: 502,
  version_mismatch: 502,
};

/** Default, user-safe message for each error code. */
export const INDEXER_ERROR_MESSAGES: Record<IndexerErrorCode, string> = {
  not_configured: 'Indexer data is not available in this environment.',
  bad_request: 'The request for indexer data was invalid.',
  unknown_resource: 'The requested indexer resource does not exist.',
  unauthorized: 'The indexer rejected the server credentials.',
  forbidden: 'The indexer denied access to this resource.',
  not_found: 'The indexer has no record of this resource.',
  rate_limited: 'The indexer is rate limiting requests. Try again shortly.',
  timeout: 'The indexer took too long to respond.',
  network: 'The indexer could not be reached.',
  upstream: 'The indexer returned an unexpected error.',
  schema: 'The indexer returned data in an unexpected format.',
  version_mismatch: 'The indexer API version is not supported by this app.',
};

const ERROR_CODES = new Set(Object.keys(INDEXER_ERROR_STATUS));

export function isIndexerErrorCode(value: unknown): value is IndexerErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value);
}

/** Codes where retrying the same request may succeed. */
export function isRetryableIndexerError(code: IndexerErrorCode): boolean {
  return code === 'timeout' || code === 'network' || code === 'upstream' || code === 'rate_limited';
}

export class IndexerError extends Error {
  readonly code: IndexerErrorCode;
  readonly status: number;

  constructor(code: IndexerErrorCode, message: string = INDEXER_ERROR_MESSAGES[code]) {
    super(message);
    this.name = 'IndexerError';
    this.code = code;
    this.status = INDEXER_ERROR_STATUS[code];
  }
}

/** Map an upstream HTTP status to an error code. */
export function indexerErrorCodeForStatus(status: number): IndexerErrorCode {
  if (status === 400) return 'bad_request';
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  return 'upstream';
}
