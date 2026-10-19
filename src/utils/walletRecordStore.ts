/**
 * Integrity-checked, namespaced, expiring storage for wallet-linked records.
 *
 * - #1087 Integrity: every record is wrapped in an envelope carrying a SHA-256
 *   digest over its scope, timestamps and payload. A record whose digest does
 *   not match is treated as tampered and is never handed to the caller.
 * - #1088 Expiry: every record carries `expiresAt`; the retention window per
 *   record kind lives in `WALLET_RECORD_RETENTION_MS` (see
 *   docs/wallet-storage-integrity.md). Expired records are deleted on read and
 *   by `purgeExpiredWalletRecords()`.
 * - #1089 Isolation: the storage key and the envelope both bind the record to
 *   the page origin, the Stellar network passphrase and the wallet address.
 *   A record read under a different scope is rejected.
 * - #1097 Recovery: every rejected record is removed and reported with a typed
 *   reason so the UI can tell the user what happened instead of silently
 *   loading (or silently dropping) bad data.
 *
 * Threat model: the digest detects corruption, manual/extension edits and
 * records copied between wallets, networks or origins. It is not a secret-key
 * MAC — script running on this origin can recompute it — so XSS remains the
 * job of the CSP (see docs/localstorage-sensitivity-audit.md).
 */

import { NETWORK_PASSPHRASE } from '@/constants';
import { sha256Hex } from '@/utils/sha256';

const WALLET_RECORD_SCHEMA_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Retention window per record kind, measured from the record's last write. */
export const WALLET_RECORD_RETENTION_MS = {
  'address-book': 90 * DAY_MS,
} as const;

export type WalletRecordKind = keyof typeof WALLET_RECORD_RETENTION_MS;

/**
 * Key prefix per kind. Each prefix must also be covered by
 * `WALLET_SCOPED_PREFIXES` in walletStorage.ts so disconnect clears it.
 */
const WALLET_RECORD_KEY_PREFIX: Record<WalletRecordKind, string> = {
  'address-book': 'iln-address-book-',
};

export interface WalletRecordScope {
  origin: string;
  network: string;
  wallet: string;
}

export type WalletRecordRejection =
  | 'CORRUPT'
  | 'UNSUPPORTED_VERSION'
  | 'TAMPERED'
  | 'SCOPE_MISMATCH'
  | 'EXPIRED'
  | 'INVALID_SHAPE';

export type WalletRecordReadResult<T> =
  | { status: 'ok'; data: T; migrated: boolean }
  | { status: 'missing' }
  | { status: 'rejected'; reason: WalletRecordRejection }
  | { status: 'unavailable' };

export interface WalletRecordEnvelope<T = unknown> {
  v: number;
  kind: WalletRecordKind;
  scope: WalletRecordScope;
  savedAt: number;
  expiresAt: number;
  data: T;
  digest: string;
}

export interface WalletRecordOptions {
  storage?: Storage;
  now?: number;
}

/** Scope for the current page origin and configured Stellar network. */
export function currentWalletRecordScope(wallet: string): WalletRecordScope {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return { origin, network: NETWORK_PASSPHRASE, wallet };
}

function namespaceTag(scope: WalletRecordScope): string {
  return sha256Hex(`${scope.origin}\n${scope.network}`).slice(0, 12);
}

/** Storage key: `<prefix>v1-<origin+network tag>-<wallet>`. */
export function walletRecordKey(kind: WalletRecordKind, scope: WalletRecordScope): string {
  return `${WALLET_RECORD_KEY_PREFIX[kind]}v${WALLET_RECORD_SCHEMA_VERSION}-${namespaceTag(scope)}-${scope.wallet}`;
}

/** Pre-envelope key (`<prefix><wallet>`), migrated on first read. */
export function legacyWalletRecordKey(kind: WalletRecordKind, wallet: string): string {
  return `${WALLET_RECORD_KEY_PREFIX[kind]}${wallet}`;
}

export function computeWalletRecordDigest(envelope: Omit<WalletRecordEnvelope, 'digest'>): string {
  // Fixed-order array so the digest input is canonical regardless of key order.
  return sha256Hex(
    JSON.stringify([
      envelope.v,
      envelope.kind,
      envelope.scope.origin,
      envelope.scope.network,
      envelope.scope.wallet,
      envelope.savedAt,
      envelope.expiresAt,
      envelope.data,
    ])
  );
}

function isEnvelope(value: unknown): value is WalletRecordEnvelope {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  const scope = e.scope as Record<string, unknown> | null | undefined;
  return (
    typeof e.v === 'number' &&
    typeof e.kind === 'string' &&
    !!scope &&
    typeof scope === 'object' &&
    typeof scope.origin === 'string' &&
    typeof scope.network === 'string' &&
    typeof scope.wallet === 'string' &&
    typeof e.savedAt === 'number' &&
    typeof e.expiresAt === 'number' &&
    'data' in e &&
    typeof e.digest === 'string'
  );
}

function sameScope(a: WalletRecordScope, b: WalletRecordScope): boolean {
  return a.origin === b.origin && a.network === b.network && a.wallet === b.wallet;
}

function safeRemove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // Removal is best-effort recovery; the record is still never returned.
  }
}

/**
 * Validate a parsed envelope against the expected kind/scope/time.
 * Returns the rejection reason, or null when the envelope is trustworthy.
 */
function verifyEnvelope(
  envelope: WalletRecordEnvelope,
  kind: WalletRecordKind,
  scope: WalletRecordScope | null,
  now: number
): WalletRecordRejection | null {
  if (envelope.v !== WALLET_RECORD_SCHEMA_VERSION) return 'UNSUPPORTED_VERSION';
  const { digest, ...unsigned } = envelope;
  if (computeWalletRecordDigest(unsigned) !== digest) return 'TAMPERED';
  if (envelope.kind !== kind) return 'SCOPE_MISMATCH';
  if (scope && !sameScope(envelope.scope, scope)) return 'SCOPE_MISMATCH';
  // A lifetime longer than the policy allows means expiresAt was pushed out.
  if (envelope.expiresAt - envelope.savedAt > WALLET_RECORD_RETENTION_MS[kind]) return 'TAMPERED';
  if (now >= envelope.expiresAt) return 'EXPIRED';
  return null;
}

/** Wrap and persist `data`. Returns false if storage throws (quota, disabled). */
export function writeWalletRecord<T>(
  kind: WalletRecordKind,
  scope: WalletRecordScope,
  data: T,
  { storage = window.localStorage, now = Date.now() }: WalletRecordOptions = {}
): boolean {
  const unsigned = {
    v: WALLET_RECORD_SCHEMA_VERSION,
    kind,
    scope: { origin: scope.origin, network: scope.network, wallet: scope.wallet },
    savedAt: now,
    expiresAt: now + WALLET_RECORD_RETENTION_MS[kind],
    data,
  };
  const envelope: WalletRecordEnvelope<T> = {
    ...unsigned,
    digest: computeWalletRecordDigest(unsigned),
  };
  try {
    storage.setItem(walletRecordKey(kind, scope), JSON.stringify(envelope));
    return true;
  } catch (e) {
    console.error(`Failed to persist ${kind} record`, e);
    return false;
  }
}

/**
 * Read and verify a record. Rejected records are removed from storage.
 * A pre-envelope record at the legacy key is validated, re-written as an
 * envelope under the scoped key, and the legacy key is removed.
 */
export function readWalletRecord<T>(
  kind: WalletRecordKind,
  scope: WalletRecordScope,
  isValid: (data: unknown) => data is T,
  { storage = window.localStorage, now = Date.now() }: WalletRecordOptions = {}
): WalletRecordReadResult<T> {
  const key = walletRecordKey(kind, scope);
  const legacyKey = legacyWalletRecordKey(kind, scope.wallet);
  let raw: string | null;
  let legacyRaw: string | null = null;
  try {
    raw = storage.getItem(key);
    if (raw === null) legacyRaw = storage.getItem(legacyKey);
  } catch (e) {
    console.error(`Failed to read ${kind} record`, e);
    return { status: 'unavailable' };
  }

  if (raw === null) {
    if (legacyRaw === null) return { status: 'missing' };
    return migrateLegacy(kind, scope, legacyKey, legacyRaw, isValid, storage, now);
  }

  const reject = (reason: WalletRecordRejection): WalletRecordReadResult<T> => {
    safeRemove(storage, key);
    return { status: 'rejected', reason };
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return reject('CORRUPT');
  }
  if (!isEnvelope(parsed)) return reject('CORRUPT');

  const rejection = verifyEnvelope(parsed, kind, scope, now);
  if (rejection) return reject(rejection);
  if (!isValid(parsed.data)) return reject('INVALID_SHAPE');

  return { status: 'ok', data: parsed.data, migrated: false };
}

function migrateLegacy<T>(
  kind: WalletRecordKind,
  scope: WalletRecordScope,
  legacyKey: string,
  legacyRaw: string,
  isValid: (data: unknown) => data is T,
  storage: Storage,
  now: number
): WalletRecordReadResult<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(legacyRaw);
  } catch {
    safeRemove(storage, legacyKey);
    return { status: 'rejected', reason: 'CORRUPT' };
  }
  if (!isValid(parsed)) {
    safeRemove(storage, legacyKey);
    return { status: 'rejected', reason: 'INVALID_SHAPE' };
  }
  // Only drop the legacy copy once the scoped copy is safely written.
  if (writeWalletRecord(kind, scope, parsed, { storage, now })) {
    safeRemove(storage, legacyKey);
  }
  return { status: 'ok', data: parsed, migrated: true };
}

/**
 * Remove every record of every kind that is expired, unreadable or fails its
 * integrity check, regardless of which wallet/network it belongs to. Records
 * that are valid for another wallet or network are kept. Returns the number
 * of keys removed.
 */
export function purgeExpiredWalletRecords({
  storage = window.localStorage,
  now = Date.now(),
}: WalletRecordOptions = {}): number {
  const toRemove: string[] = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key) continue;
      const kind = (Object.keys(WALLET_RECORD_KEY_PREFIX) as WalletRecordKind[]).find((k) =>
        key.startsWith(`${WALLET_RECORD_KEY_PREFIX[k]}v${WALLET_RECORD_SCHEMA_VERSION}-`)
      );
      if (!kind) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(storage.getItem(key) ?? '');
      } catch {
        toRemove.push(key);
        continue;
      }
      if (!isEnvelope(parsed) || verifyEnvelope(parsed, kind, null, now) !== null) {
        toRemove.push(key);
      }
    }
  } catch (e) {
    console.error('Failed to scan wallet records for expiry', e);
    return 0;
  }
  toRemove.forEach((key) => safeRemove(storage, key));
  return toRemove.length;
}
