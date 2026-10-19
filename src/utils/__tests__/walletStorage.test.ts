import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearWalletStorage,
  createSafeStorage,
  getSafeStorage,
  getStorageStatus,
  getStoredWalletAddress,
  getStoredWalletProvider,
  hydrateAddressBookRecords,
  MemoryStorage,
  resetStorageStatus,
  SafeStorage,
  serializeAddressBookEnvelope,
  setStoredWalletAddress,
  setStoredWalletProvider,
  validateAddressBookEntry,
  WALLET_ADDRESS_STORAGE_KEY,
  WALLET_PROVIDER_STORAGE_KEY,
} from '../walletStorage';

describe('walletStorage (#4, wave-9)', () => {
  const TEST_WALLET_A = 'GBZXN7PIRZGNMHGA728R46MQ7ONLC3O3PNGGATUACCGWGL72WNZKSCGS';
  const TEST_WALLET_B = 'GARY6Z5RNCDTZSD2453U5P3FSG4J4OISUGB53L575K7YV33XBC3G3D4M';

  beforeEach(() => {
    localStorage.clear();
    resetStorageStatus();
  });

  describe('clearWalletStorage', () => {
    it('removes the stored address and wallet-scoped caches', () => {
      localStorage.setItem(WALLET_ADDRESS_STORAGE_KEY, TEST_WALLET_A);
      localStorage.setItem(`iln-address-book-${TEST_WALLET_A}`, '[]');
      localStorage.setItem('iln-referral-7', 'CODE');
      localStorage.setItem('iln-watchlist', '[]');
      localStorage.setItem('freelancerInvoices.statuses', 'Paid');

      clearWalletStorage();

      expect(localStorage.getItem(WALLET_ADDRESS_STORAGE_KEY)).toBeNull();
      expect(localStorage.getItem(`iln-address-book-${TEST_WALLET_A}`)).toBeNull();
      expect(localStorage.getItem('iln-referral-7')).toBeNull();
      expect(localStorage.getItem('iln-watchlist')).toBeNull();
      expect(localStorage.getItem('freelancerInvoices.statuses')).toBeNull();
    });

    it('leaves unrelated keys untouched', () => {
      localStorage.setItem('theme', 'dark');
      localStorage.setItem(WALLET_ADDRESS_STORAGE_KEY, TEST_WALLET_A);
      localStorage.setItem(WALLET_PROVIDER_STORAGE_KEY, 'walletconnect');

      clearWalletStorage();

      expect(localStorage.getItem('theme')).toBe('dark');
      expect(localStorage.getItem(WALLET_ADDRESS_STORAGE_KEY)).toBeNull();
      expect(localStorage.getItem(WALLET_PROVIDER_STORAGE_KEY)).toBeNull();
    });

    it('returns the stored wallet provider and address when requested', () => {
      setStoredWalletProvider('walletconnect');
      expect(getStoredWalletProvider()).toBe('walletconnect');

      setStoredWalletAddress(TEST_WALLET_A);
      expect(getStoredWalletAddress()).toBe(TEST_WALLET_A);
    });
  });

  describe('SafeStorage & Degraded Mode (Quota & Privacy Failures)', () => {
    it('MemoryStorage functions as an in-memory Storage implementation', () => {
      const mem = new MemoryStorage();
      expect(mem.length).toBe(0);

      mem.setItem('key1', 'val1');
      mem.setItem('key2', 'val2');
      expect(mem.length).toBe(2);
      expect(mem.getItem('key1')).toBe('val1');
      expect(mem.key(0)).toBe('key1');

      mem.removeItem('key1');
      expect(mem.length).toBe(1);
      expect(mem.getItem('key1')).toBeNull();

      mem.clear();
      expect(mem.length).toBe(0);
    });

    it('degrades safely to in-memory mode when QuotaExceededError is thrown', () => {
      const mockBackend: Storage = {
        length: 0,
        clear: () => {},
        getItem: () => null,
        key: () => null,
        removeItem: () => {},
        setItem: () => {
          const quotaErr = new DOMException('Quota exceeded', 'QuotaExceededError');
          throw quotaErr;
        },
      };

      const safe = new SafeStorage(mockBackend);
      safe.setItem('critical_key', 'session_data');

      const status = getStorageStatus();
      expect(status.degraded).toBe(true);
      expect(status.available).toBe(false);
      expect(status.quotaExceeded).toBe(true);

      // Data is preserved in-memory so user does not lose session data
      expect(safe.getItem('critical_key')).toBe('session_data');
    });

    it('degrades safely when private browsing blocks writes (SecurityError)', () => {
      const mockBackend: Storage = {
        length: 0,
        clear: () => {},
        getItem: () => null,
        key: () => null,
        removeItem: () => {},
        setItem: () => {
          throw new DOMException('The operation is insecure.', 'SecurityError');
        },
      };

      const safe = new SafeStorage(mockBackend);
      safe.setItem('private_key', 'some_value');

      const status = getStorageStatus();
      expect(status.degraded).toBe(true);
      expect(status.quotaExceeded).toBe(false);
      expect(safe.getItem('private_key')).toBe('some_value');
    });
  });

  describe('Validation before Hydration (validateAddressBookEntry)', () => {
    it('accepts valid entries with only id, address, and nickname', () => {
      const valid = {
        id: 'entry-1',
        address: TEST_WALLET_A,
        nickname: 'Alice Main',
      };
      const result = validateAddressBookEntry(valid);
      expect(result.valid).toBe(true);
      expect(result.entry).toEqual(valid);
    });

    it('rejects entries containing unknown fields (strict schema validation)', () => {
      const entryWithUnknown = {
        id: 'entry-1',
        address: TEST_WALLET_A,
        nickname: 'Alice',
        unauthorizedField: 'attacker_payload',
        role: 'admin',
      };
      const result = validateAddressBookEntry(entryWithUnknown);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('unknown/unauthorized fields');
    });

    it('rejects malformed entries (missing id, empty address, invalid types)', () => {
      expect(validateAddressBookEntry(null).valid).toBe(false);
      expect(validateAddressBookEntry([]).valid).toBe(false);
      expect(validateAddressBookEntry('string').valid).toBe(false);

      expect(
        validateAddressBookEntry({ id: '', address: TEST_WALLET_A, nickname: 'Alice' }).valid
      ).toBe(false);
      expect(validateAddressBookEntry({ id: '1', address: '', nickname: 'Alice' }).valid).toBe(
        false
      );
      expect(
        validateAddressBookEntry({ id: '1', address: TEST_WALLET_A, nickname: '' }).valid
      ).toBe(false);
      expect(
        validateAddressBookEntry({ id: 123, address: TEST_WALLET_A, nickname: 'Alice' }).valid
      ).toBe(false);
    });

    it('rejects addresses with invalid characters or whitespace', () => {
      const badAddress = {
        id: 'entry-1',
        address: 'G INVALID WITH SPACES',
        nickname: 'Alice',
      };
      const result = validateAddressBookEntry(badAddress);
      expect(result.valid).toBe(false);
      expect(result.reason).toContain('invalid characters');
    });
  });

  describe('Migration Versioning & Hydration (hydrateAddressBookRecords)', () => {
    it('returns empty result for null or empty input', () => {
      const result = hydrateAddressBookRecords(null, TEST_WALLET_A);
      expect(result.success).toBe(true);
      expect(result.entries).toEqual([]);
      expect(result.version).toBe(1);
    });

    it('returns error when storage contains corrupt JSON', () => {
      const result = hydrateAddressBookRecords('{"invalid json', TEST_WALLET_A);
      expect(result.success).toBe(false);
      expect(result.entries).toEqual([]);
      expect(result.error).toContain('invalid JSON');
    });

    it('migrates legacy v0 unversioned array to v1 without silently dropping valid records', () => {
      const legacyV0Data = [
        { id: 'leg-1', address: TEST_WALLET_A, nickname: 'Alice V0' },
        { address: TEST_WALLET_B, nickname: 'Bob Missing ID' }, // missing id -> must be migrated
      ];

      const result = hydrateAddressBookRecords(JSON.stringify(legacyV0Data), TEST_WALLET_A);

      expect(result.success).toBe(true);
      expect(result.migrated).toBe(true);
      expect(result.version).toBe(1);
      expect(result.entries).toHaveLength(2);
      expect(result.entries[0].nickname).toBe('Alice V0');
      expect(result.entries[1].nickname).toBe('Bob Missing ID');
      expect(result.entries[1].id).toBeTruthy(); // ID generated during migration
    });

    it('filters out malformed records in legacy v0 data while preserving valid records', () => {
      const legacyWithBadEntry = [
        { id: '1', address: TEST_WALLET_A, nickname: 'Good Record' },
        { id: '2', address: 'BAD ADDRESS WITH SPACES', nickname: 'Malformed' },
        null,
      ];

      const result = hydrateAddressBookRecords(JSON.stringify(legacyWithBadEntry), TEST_WALLET_A);

      expect(result.success).toBe(true);
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].nickname).toBe('Good Record');
      expect(result.rejectedCount).toBe(2);
      expect(result.reasons).toHaveLength(2);
    });

    it('verifies wallet ownership and rejects hydration if envelope belongs to another wallet', () => {
      const envelopeForWalletB = {
        version: 1,
        walletAddress: TEST_WALLET_B,
        data: [{ id: '1', address: TEST_WALLET_B, nickname: 'Wallet B Record' }],
        updatedAt: Date.now(),
      };

      // Attempt to hydrate while logged in as TEST_WALLET_A
      const result = hydrateAddressBookRecords(JSON.stringify(envelopeForWalletB), TEST_WALLET_A);

      expect(result.success).toBe(false);
      expect(result.ownershipVerified).toBe(false);
      expect(result.entries).toHaveLength(0);
      expect(result.error).toContain('Wallet ownership mismatch');
    });

    it('hydrates valid version 1 envelope successfully', () => {
      const validEnvelope = {
        version: 1,
        walletAddress: TEST_WALLET_A,
        data: [{ id: '1', address: TEST_WALLET_B, nickname: 'Bob' }],
        updatedAt: Date.now(),
      };

      const result = hydrateAddressBookRecords(JSON.stringify(validEnvelope), TEST_WALLET_A);

      expect(result.success).toBe(true);
      expect(result.ownershipVerified).toBe(true);
      expect(result.migrated).toBe(false);
      expect(result.entries).toEqual(validEnvelope.data);
    });

    it('rejects version 1 envelope with unknown fields in entries', () => {
      const envelopeWithInjectedField = {
        version: 1,
        walletAddress: TEST_WALLET_A,
        data: [{ id: '1', address: TEST_WALLET_B, nickname: 'Bob', injectedCode: '<script>' }],
        updatedAt: Date.now(),
      };

      const result = hydrateAddressBookRecords(
        JSON.stringify(envelopeWithInjectedField),
        TEST_WALLET_A
      );

      expect(result.success).toBe(true);
      expect(result.entries).toHaveLength(0);
      expect(result.rejectedCount).toBe(1);
      expect(result.reasons[0]).toContain('unknown/unauthorized fields');
    });

    it('handles unsupported future schema versions gracefully without crashing', () => {
      const futureEnvelope = {
        version: 999,
        walletAddress: TEST_WALLET_A,
        data: [],
        updatedAt: Date.now(),
      };

      const result = hydrateAddressBookRecords(JSON.stringify(futureEnvelope), TEST_WALLET_A);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unsupported address book schema version');
    });

    it('serializes address book envelope with version and wallet ownership', () => {
      const entries = [{ id: '1', address: TEST_WALLET_B, nickname: 'Bob' }];
      const serialized = serializeAddressBookEnvelope(entries, TEST_WALLET_A);

      const parsed = JSON.parse(serialized);
      expect(parsed.version).toBe(1);
      expect(parsed.walletAddress).toBe(TEST_WALLET_A);
      expect(parsed.data).toEqual(entries);
      expect(typeof parsed.updatedAt).toBe('number');
    });
  });
});
