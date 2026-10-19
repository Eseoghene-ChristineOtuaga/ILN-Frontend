/**
 * Indexer API version negotiation.
 *
 * The proxy advertises the contract it was built against with an
 * `Accept-Version` request header, and the indexer must answer with an
 * `X-Indexer-Api-Version` semver header. Responses from an incompatible
 * major version (or an older minor than this app needs) are rejected with a
 * `version_mismatch` error before their payload is parsed, so schema drift
 * fails clearly instead of surfacing as confusing validation errors.
 */

import { IndexerError } from './errors';

export const INDEXER_VERSION_REQUEST_HEADER = 'Accept-Version';
export const INDEXER_VERSION_RESPONSE_HEADER = 'X-Indexer-Api-Version';

/** The indexer contract this frontend's resource parsers are written against. */
export const SUPPORTED_INDEXER_API = { major: 1, minMinor: 0 } as const;

export const SUPPORTED_INDEXER_API_RANGE = `${SUPPORTED_INDEXER_API.major}.x (>= ${SUPPORTED_INDEXER_API.major}.${SUPPORTED_INDEXER_API.minMinor})`;

export interface IndexerApiVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

const SEMVER = /^v?(\d{1,4})\.(\d{1,4})(?:\.(\d{1,6}))?(?:[-+][0-9A-Za-z.-]+)?$/;

export function parseIndexerApiVersion(raw: string | null | undefined): IndexerApiVersion | null {
  const value = raw?.trim();
  if (!value) return null;
  const match = SEMVER.exec(value);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    raw: value,
  };
}

export type IndexerVersionPolicy = 'strict' | 'allow-missing';

/**
 * Validate the indexer's declared API version.
 *
 * - Incompatible or unparseable versions always fail.
 * - A missing header fails under `strict` (the default). `allow-missing`
 *   exists only to roll out against indexers that predate the header; it logs
 *   a warning and reports the version as `unknown`.
 */
export function negotiateIndexerVersion(
  header: string | null,
  policy: IndexerVersionPolicy = 'strict'
): string {
  if (header === null || header.trim() === '') {
    if (policy === 'allow-missing') {
      console.warn(
        `[indexer] response is missing ${INDEXER_VERSION_RESPONSE_HEADER}; ` +
          'version checks are disabled by INDEXER_API_VERSION_POLICY=allow-missing.'
      );
      return 'unknown';
    }
    throw new IndexerError(
      'version_mismatch',
      `The indexer did not declare an API version. This app requires ${SUPPORTED_INDEXER_API_RANGE}.`
    );
  }

  const version = parseIndexerApiVersion(header);
  if (!version) {
    throw new IndexerError(
      'version_mismatch',
      `The indexer declared an unrecognised API version. This app requires ${SUPPORTED_INDEXER_API_RANGE}.`
    );
  }

  const compatible =
    version.major === SUPPORTED_INDEXER_API.major &&
    version.minor >= SUPPORTED_INDEXER_API.minMinor;
  if (!compatible) {
    throw new IndexerError(
      'version_mismatch',
      `The indexer API version ${version.major}.${version.minor}.${version.patch} is not supported. ` +
        `This app requires ${SUPPORTED_INDEXER_API_RANGE}.`
    );
  }

  return `${version.major}.${version.minor}.${version.patch}`;
}
