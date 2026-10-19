/**
 * Tamper/expiry/isolation coverage for wallet-linked storage (#1087, #1088,
 * #1089, #1097). All fixtures are deterministic: fixed clock, fixed scopes,
 * fixed payloads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  computeWalletRecordDigest,
  currentWalletRecordScope,
  legacyWalletRecordKey,
  purgeExpiredWalletRecords,
  readWalletRecord,
  WALLET_RECORD_RETENTION_MS,
  walletRecordKey,
  writeWalletRecord,
  type WalletRecordEnvelope,
  type WalletRecordScope,
} from '../walletRecordStore';
import { clearWalletStorage } from '../walletStorage';

const NOW = Date.UTC(2026, 0, 1);
const RETENTION = WALLET_RECORD_RETENTION_MS['address-book'];

const WALLET_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC';
const WALLET_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD';
const TESTNET = 'Test SDF Network ; September 2015';
const PUBNET = 'Public Global Stellar Network ; September 2015';

const SCOPE_A: WalletRecordScope = {
  origin: 'https://app.iln.test',
  network: TESTNET,
  wallet: WALLET_A,
};
const SCOPE_B: WalletRecordScope = { ...SCOPE_A, wallet: WALLET_B };
const SCOPE_A_PUBNET: WalletRecordScope = { ...SCOPE_A, network: PUBNET };
const SCOPE_A_OTHER_ORIGIN: WalletRecordScope = { ...SCOPE_A, origin: 'https://evil.example' };

type Entry = { id: string; address: string; nickname: string };
const ENTRIES: Entry[] = [{ id: '1', address: WALLET_B, nickname: 'Bob' }];

const isEntries = (value: unknown): value is Entry[] =>
  Array.isArray(value) &&
  value.every(
    (e) =>
      e &&
      typeof e.id === 'string' &&
      typeof e.address === 'string' &&
      typeof e.nickname === 'string'
  );

const opts = (now = NOW) => ({ storage: localStorage, now });
const read = (scope = SCOPE_A, now = NOW) =>
  readWalletRecord('address-book', scope, isEntries, opts(now));
const write = (scope = SCOPE_A, data: unknown = ENTRIES, now = NOW) =>
  writeWalletRecord('address-book', scope, data, opts(now));
const keyOf = (scope = SCOPE_A) => walletRecordKey('address-book', scope);
const envelopeAt = (key: string) => JSON.parse(localStorage.getItem(key)!) as WalletRecordEnvelope;

/** Re-sign an edited envelope, simulating an attacker who knows the format. */
function resign(envelope: WalletRecordEnvelope): WalletRecordEnvelope {
  const { digest: _digest, ...unsigned } = envelope;
  return { ...unsigned, digest: computeWalletRecordDigest(unsigned) };
}

describe('walletRecordStore', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('integrity (#1087)', () => {
    it('round-trips a written record', () => {
      expect(write()).toBe(true);
      expect(read()).toEqual({ status: 'ok', data: ENTRIES, migrated: false });
    });

    it('stores a digest bound to scope, timestamps and payload', () => {
      write();
      const envelope = envelopeAt(keyOf());
      expect(envelope).toMatchObject({
        v: 1,
        kind: 'address-book',
        scope: SCOPE_A,
        savedAt: NOW,
        expiresAt: NOW + RETENTION,
        data: ENTRIES,
      });
      expect(envelope.digest).toMatch(/^[0-9a-f]{64}$/);
    });

    it('rejects and removes a record whose payload was modified', () => {
      write();
      const envelope = envelopeAt(keyOf());
      envelope.data = [{ id: '1', address: WALLET_A, nickname: 'Bob' }];
      localStorage.setItem(keyOf(), JSON.stringify(envelope));

      expect(read()).toEqual({ status: 'rejected', reason: 'TAMPERED' });
      expect(localStorage.getItem(keyOf())).toBeNull();
    });

    it('rejects a record whose digest was modified', () => {
      write();
      const envelope = envelopeAt(keyOf());
      envelope.digest = '0'.repeat(64);
      localStorage.setItem(keyOf(), JSON.stringify(envelope));
      expect(read()).toEqual({ status: 'rejected', reason: 'TAMPERED' });
    });

    it('rejects a re-signed record whose lifetime exceeds the retention policy', () => {
      write();
      const envelope = resign({ ...envelopeAt(keyOf()), expiresAt: NOW + RETENTION * 10 });
      localStorage.setItem(keyOf(), JSON.stringify(envelope));
      expect(read()).toEqual({ status: 'rejected', reason: 'TAMPERED' });
    });

    it.each([
      ['invalid JSON', '{"v":1,'],
      ['a bare array', JSON.stringify(ENTRIES)],
      ['null', 'null'],
      ['an envelope missing its digest', JSON.stringify({ v: 1, kind: 'address-book' })],
    ])('rejects %s as CORRUPT and removes it', (_label, raw) => {
      localStorage.setItem(keyOf(), raw);
      expect(read()).toEqual({ status: 'rejected', reason: 'CORRUPT' });
      expect(localStorage.getItem(keyOf())).toBeNull();
    });

    it('rejects an unknown schema version', () => {
      write();
      localStorage.setItem(keyOf(), JSON.stringify({ ...envelopeAt(keyOf()), v: 99 }));
      expect(read()).toEqual({ status: 'rejected', reason: 'UNSUPPORTED_VERSION' });
    });

    it('rejects a correctly signed payload with the wrong shape', () => {
      write(SCOPE_A, [{ id: 1, address: null }]);
      expect(read()).toEqual({ status: 'rejected', reason: 'INVALID_SHAPE' });
      expect(localStorage.getItem(keyOf())).toBeNull();
    });
  });

  describe('expiry (#1088)', () => {
    it('returns the record until the retention window ends', () => {
      write();
      expect(read(SCOPE_A, NOW + RETENTION - 1).status).toBe('ok');
    });

    it('rejects and removes the record once expired', () => {
      write();
      expect(read(SCOPE_A, NOW + RETENTION)).toEqual({ status: 'rejected', reason: 'EXPIRED' });
      expect(localStorage.getItem(keyOf())).toBeNull();
    });

    it('re-writing a record restarts its retention window', () => {
      write();
      write(SCOPE_A, ENTRIES, NOW + RETENTION - 1);
      expect(read(SCOPE_A, NOW + RETENTION + 1000).status).toBe('ok');
    });

    it('purge removes expired and tampered records for any wallet but keeps valid ones', () => {
      write(SCOPE_A, ENTRIES, NOW - RETENTION); // expires exactly at NOW
      write(SCOPE_B, ENTRIES, NOW); // valid
      write(SCOPE_A_PUBNET, ENTRIES, NOW); // valid, other network
      const tamperedKey = keyOf(SCOPE_A_OTHER_ORIGIN);
      write(SCOPE_A_OTHER_ORIGIN, ENTRIES, NOW);
      localStorage.setItem(tamperedKey, JSON.stringify({ ...envelopeAt(tamperedKey), data: [] }));
      const corruptKey = 'iln-address-book-v1-deadbeef0000-GCORRUPT';
      localStorage.setItem(corruptKey, 'not json');
      localStorage.setItem('theme', 'dark');

      expect(purgeExpiredWalletRecords(opts())).toBe(3);

      expect(localStorage.getItem(keyOf(SCOPE_A))).toBeNull();
      expect(localStorage.getItem(tamperedKey)).toBeNull();
      expect(localStorage.getItem(corruptKey)).toBeNull();
      expect(localStorage.getItem(keyOf(SCOPE_B))).not.toBeNull();
      expect(localStorage.getItem(keyOf(SCOPE_A_PUBNET))).not.toBeNull();
      expect(localStorage.getItem('theme')).toBe('dark');
    });

    it('purge leaves legacy (pre-envelope) keys for migration on read', () => {
      localStorage.setItem(
        legacyWalletRecordKey('address-book', WALLET_A),
        JSON.stringify(ENTRIES)
      );
      expect(purgeExpiredWalletRecords(opts())).toBe(0);
    });
  });

  describe('isolation (#1089)', () => {
    it('namespaces keys by origin and network as well as wallet', () => {
      const keys = new Set([
        keyOf(SCOPE_A),
        keyOf(SCOPE_B),
        keyOf(SCOPE_A_PUBNET),
        keyOf(SCOPE_A_OTHER_ORIGIN),
      ]);
      expect(keys.size).toBe(4);
      keys.forEach((key) => expect(key.startsWith('iln-address-book-v1-')).toBe(true));
      expect(keyOf(SCOPE_A).endsWith(WALLET_A)).toBe(true);
    });

    it('does not expose one network’s record to another network', () => {
      write(SCOPE_A);
      expect(read(SCOPE_A_PUBNET)).toEqual({ status: 'missing' });
    });

    it.each([
      ['wallet', SCOPE_B],
      ['network', SCOPE_A_PUBNET],
      ['origin', SCOPE_A_OTHER_ORIGIN],
    ])('rejects a record copied from another %s as SCOPE_MISMATCH', (_label, foreignScope) => {
      write(foreignScope);
      localStorage.setItem(keyOf(SCOPE_A), localStorage.getItem(keyOf(foreignScope))!);

      expect(read(SCOPE_A)).toEqual({ status: 'rejected', reason: 'SCOPE_MISMATCH' });
      expect(localStorage.getItem(keyOf(SCOPE_A))).toBeNull();
      // The legitimate owner's copy is untouched.
      expect(read(foreignScope).status).toBe('ok');
    });

    it('derives the current scope from the page origin and configured network', () => {
      expect(currentWalletRecordScope(WALLET_A)).toEqual({
        origin: window.location.origin,
        network: TESTNET,
        wallet: WALLET_A,
      });
    });

    it('disconnect cleanup removes scoped records', () => {
      write(SCOPE_A);
      write(SCOPE_A_PUBNET);
      clearWalletStorage();
      expect(localStorage.getItem(keyOf(SCOPE_A))).toBeNull();
      expect(localStorage.getItem(keyOf(SCOPE_A_PUBNET))).toBeNull();
    });
  });

  describe('legacy migration and failure handling (#1097)', () => {
    const legacyKey = legacyWalletRecordKey('address-book', WALLET_A);

    it('migrates a valid legacy record into a scoped envelope', () => {
      localStorage.setItem(legacyKey, JSON.stringify(ENTRIES));
      expect(read()).toEqual({ status: 'ok', data: ENTRIES, migrated: true });
      expect(localStorage.getItem(legacyKey)).toBeNull();
      expect(read()).toEqual({ status: 'ok', data: ENTRIES, migrated: false });
    });

    it('keeps the legacy record if the migrated copy cannot be written', () => {
      localStorage.setItem(legacyKey, JSON.stringify(ENTRIES));
      vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(read()).toEqual({ status: 'ok', data: ENTRIES, migrated: true });
      expect(localStorage.getItem(legacyKey)).not.toBeNull();
    });

    it.each([
      ['corrupt', '[{', 'CORRUPT'],
      ['wrong shape', JSON.stringify({ hello: 'world' }), 'INVALID_SHAPE'],
    ])('rejects and removes a %s legacy record', (_label, raw, reason) => {
      localStorage.setItem(legacyKey, raw);
      expect(read()).toEqual({ status: 'rejected', reason });
      expect(localStorage.getItem(legacyKey)).toBeNull();
    });

    it('reports unavailable (without throwing) when storage reads throw', () => {
      vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
        throw new DOMException('denied', 'SecurityError');
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(read()).toEqual({ status: 'unavailable' });
    });

    it('returns false when the write throws', () => {
      vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
        throw new DOMException('quota', 'QuotaExceededError');
      });
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(write()).toBe(false);
    });

    it('a fresh write succeeds after a tampered record was discarded', () => {
      localStorage.setItem(keyOf(), 'garbage');
      expect(read().status).toBe('rejected');
      expect(write()).toBe(true);
      expect(read()).toEqual({ status: 'ok', data: ENTRIES, migrated: false });
    });
  });
});
