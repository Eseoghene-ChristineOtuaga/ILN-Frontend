/**
 * useAddressBook hook tests — encryption-aware
 *
 * Covers:
 *  - #863  addAddress / updateAddress validate Stellar address format and
 *          reject duplicates with typed error codes
 *  - #864  addAddress / updateAddress return PERSIST_FAILED and do NOT
 *          commit state when localStorage.setItem throws
 *  - #1086 entries are encrypted at rest (AES-GCM); wallet isolation verified;
 *          legacy plaintext data is migrated transparently on first load;
 *          corrupt/undecryptable data surfaces DECRYPT_FAILED
 */
import { renderHook, act, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import useAddressBook from '../useAddressBook';
import {
  deriveKeyFromWalletAddress,
  encryptForStorage,
  decryptFromStorage,
} from '../../utils/addressBookCrypto';

// vi.mock is hoisted above module-level consts, so the address is hoisted too.
const { TEST_WALLET, OTHER_WALLET } = vi.hoisted(() => ({
  TEST_WALLET: 'GDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXABCD',
  OTHER_WALLET: 'GEYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYEFGH',
}));

let mockWalletAddress: string | null = TEST_WALLET;

vi.mock('../../context/WalletContext', () => ({
  useWallet: () => ({
    address: mockWalletAddress,
  }),
}));

// ── Valid 56-char Stellar addresses (G + [A-Z2-7]{55}) ───────────────────────

const ADDR_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC';
const ADDR_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD';
const ADDR_C = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCBE';

/**
 * Build a valid 56-char Stellar address from an index 0–999.
 */
function makeAddr(i: number): string {
  const c1 = String.fromCharCode(65 + (Math.floor(i / (26 * 26)) % 26));
  const c2 = String.fromCharCode(65 + (Math.floor(i / 26) % 26));
  const c3 = String.fromCharCode(65 + (i % 26));
  return 'G' + 'A'.repeat(52) + c1 + c2 + c3;
}

describe('useAddressBook', () => {
  beforeEach(() => {
    localStorage.clear();
    mockWalletAddress = TEST_WALLET;
    vi.restoreAllMocks();
  });

  // ── Load ──────────────────────────────────────────────────────────────────

  it('starts empty when localStorage has no entry for this wallet', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.addressBook).toHaveLength(0);
    expect(result.current.loadError).toBeNull();
  });

  it('loads and decrypts address book from localStorage', async () => {
    const key = await deriveKeyFromWalletAddress(TEST_WALLET);
    const testEntries = [
      { id: '1', address: ADDR_A, nickname: 'Test 1' },
      { id: '2', address: ADDR_B, nickname: 'Test 2' },
    ];
    const encrypted = await encryptForStorage(key, testEntries);
    localStorage.setItem(`iln-address-book-${TEST_WALLET}`, encrypted);

    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.addressBook).toHaveLength(2);
    expect(result.current.addressBook[0].nickname).toBe('Test 1');
    expect(result.current.loadError).toBeNull();
  });

  // ── Encryption at rest ────────────────────────────────────────────────────

  it('persists entries as encrypted ciphertext (not plaintext)', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addAddress(ADDR_A, 'Acme Corp');
    });

    const raw = localStorage.getItem(`iln-address-book-${TEST_WALLET}`);
    expect(raw).not.toBeNull();

    // The raw value must NOT contain the plaintext nickname or address.
    expect(raw).not.toContain('Acme Corp');
    expect(raw).not.toContain(ADDR_A);

    // Confirm it is a valid EncryptedPayload shape.
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveProperty('iv');
    expect(parsed).toHaveProperty('ct');
    expect(typeof parsed.iv).toBe('string');
    expect(typeof parsed.ct).toBe('string');
  });

  it('can decrypt what it encrypts — round-trip', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addAddress(ADDR_A, 'Round-trip test');
    });

    const raw = localStorage.getItem(`iln-address-book-${TEST_WALLET}`)!;
    const key = await deriveKeyFromWalletAddress(TEST_WALLET);
    const decrypted = await decryptFromStorage<{ address: string; nickname: string }[]>(key, raw);

    expect(decrypted).not.toBeNull();
    expect(decrypted![0].nickname).toBe('Round-trip test');
    expect(decrypted![0].address).toBe(ADDR_A);
  });

  // ── Wallet isolation ──────────────────────────────────────────────────────

  it('cannot decrypt wallet-A data with wallet-B key', async () => {
    // Write data encrypted under TEST_WALLET
    const keyA = await deriveKeyFromWalletAddress(TEST_WALLET);
    const entries = [{ id: '1', address: ADDR_A, nickname: 'Secret' }];
    const encrypted = await encryptForStorage(keyA, entries);
    localStorage.setItem(`iln-address-book-${TEST_WALLET}`, encrypted);

    // Attempt to decrypt the same blob with the OTHER_WALLET key.
    const keyB = await deriveKeyFromWalletAddress(OTHER_WALLET);
    await expect(decryptFromStorage(keyB, encrypted)).rejects.toThrow();
  });

  it('reads an empty address book when a different wallet is connected', async () => {
    // Pre-populate address book for TEST_WALLET
    const keyA = await deriveKeyFromWalletAddress(TEST_WALLET);
    const entries = [{ id: '1', address: ADDR_A, nickname: 'Alice' }];
    localStorage.setItem(
      `iln-address-book-${TEST_WALLET}`,
      await encryptForStorage(keyA, entries)
    );

    // Switch to the other wallet — it has no data.
    mockWalletAddress = OTHER_WALLET;
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.addressBook).toHaveLength(0);
    expect(result.current.loadError).toBeNull();
  });

  // ── Legacy plaintext migration ────────────────────────────────────────────

  it('migrates legacy plaintext JSON to encrypted format on first load', async () => {
    const legacy = [
      { id: '1', address: ADDR_A, nickname: 'Legacy Entry' },
    ];
    // Store as raw JSON (pre-encryption format).
    localStorage.setItem(`iln-address-book-${TEST_WALLET}`, JSON.stringify(legacy));

    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // Data is loaded correctly.
    expect(result.current.addressBook).toHaveLength(1);
    expect(result.current.addressBook[0].nickname).toBe('Legacy Entry');

    // Storage should now be encrypted.
    const raw = localStorage.getItem(`iln-address-book-${TEST_WALLET}`)!;
    expect(raw).not.toContain('Legacy Entry');
    const parsed = JSON.parse(raw);
    expect(parsed).toHaveProperty('iv');
    expect(parsed).toHaveProperty('ct');
  });

  // ── Corrupt / undecryptable data ──────────────────────────────────────────

  it('surfaces DECRYPT_FAILED and returns an empty book for corrupt data', async () => {
    localStorage.setItem(`iln-address-book-${TEST_WALLET}`, '{"iv":"bad","ct":"data"}');

    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.addressBook).toHaveLength(0);
    expect(result.current.loadError).toBe('DECRYPT_FAILED');
  });

  it('surfaces DECRYPT_FAILED for fully unparseable junk in storage', async () => {
    localStorage.setItem(`iln-address-book-${TEST_WALLET}`, 'not-json-at-all!!!');

    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.addressBook).toHaveLength(0);
    expect(result.current.loadError).toBe('DECRYPT_FAILED');
  });

  it('clears the address book when wallet disconnects', async () => {
    const key = await deriveKeyFromWalletAddress(TEST_WALLET);
    const entries = [{ id: '1', address: ADDR_A, nickname: 'Test' }];
    localStorage.setItem(
      `iln-address-book-${TEST_WALLET}`,
      await encryptForStorage(key, entries)
    );

    const { result, rerender } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.addressBook).toHaveLength(1);

    // Disconnect wallet.
    act(() => {
      mockWalletAddress = null;
    });
    rerender();
    await waitFor(() => expect(result.current.addressBook).toHaveLength(0));
  });

  // ── addAddress — success ──────────────────────────────────────────────────

  it('adds new address to address book and returns ok:true', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let addResult: Awaited<ReturnType<typeof result.current.addAddress>>;
    await act(async () => {
      addResult = await result.current.addAddress(ADDR_A, 'Acme Corp');
    });

    expect(addResult!).toEqual({ ok: true });
    expect(result.current.addressBook).toHaveLength(1);
    expect(result.current.addressBook[0]).toMatchObject({
      address: ADDR_A,
      nickname: 'Acme Corp',
    });

    // Verify persisted to localStorage (encrypted)
    const stored = localStorage.getItem(`iln-address-book-${TEST_WALLET}`);
    expect(stored).not.toBeNull();
    const key = await deriveKeyFromWalletAddress(TEST_WALLET);
    const dec = await decryptFromStorage<typeof result.current.addressBook>(key, stored!);
    expect(dec).toHaveLength(1);
  });

  // ── addAddress — validation (#863) ───────────────────────────────────────

  it('rejects empty fields with MISSING_FIELDS', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let r1: Awaited<ReturnType<typeof result.current.addAddress>>;
    let r2: Awaited<ReturnType<typeof result.current.addAddress>>;
    await act(async () => {
      r1 = await result.current.addAddress('', 'Nick');
    });
    await act(async () => {
      r2 = await result.current.addAddress(ADDR_A, '');
    });

    expect(r1!).toEqual({ ok: false, error: 'MISSING_FIELDS' });
    expect(r2!).toEqual({ ok: false, error: 'MISSING_FIELDS' });
    expect(result.current.addressBook).toHaveLength(0);
  });

  it('rejects a malformed Stellar address with INVALID_ADDRESS', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let r: Awaited<ReturnType<typeof result.current.addAddress>>;
    await act(async () => {
      r = await result.current.addAddress('BADADDRESS', 'Test');
    });

    expect(r!).toEqual({ ok: false, error: 'INVALID_ADDRESS' });
    expect(result.current.addressBook).toHaveLength(0);
  });

  it('rejects an address starting with A (not G) with INVALID_ADDRESS', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const notStellar = 'A' + ADDR_A.slice(1);

    let r: Awaited<ReturnType<typeof result.current.addAddress>>;
    await act(async () => {
      r = await result.current.addAddress(notStellar, 'Test');
    });

    expect(r!).toEqual({ ok: false, error: 'INVALID_ADDRESS' });
  });

  it('rejects a duplicate address with DUPLICATE_ADDRESS', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addAddress(ADDR_A, 'First');
    });

    let r: Awaited<ReturnType<typeof result.current.addAddress>>;
    await act(async () => {
      r = await result.current.addAddress(ADDR_A, 'Second');
    });

    expect(r!).toEqual({ ok: false, error: 'DUPLICATE_ADDRESS' });
    expect(result.current.addressBook).toHaveLength(1);
    expect(result.current.addressBook[0].nickname).toBe('First');
  });

  // ── addAddress — capacity ─────────────────────────────────────────────────

  it('enforces maximum 50 entries by evicting the oldest', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    for (let i = 0; i < 51; i++) {
      await act(async () => {
        await result.current.addAddress(makeAddr(i), `Contact ${i}`);
      });
    }

    expect(result.current.addressBook).toHaveLength(50);
    expect(result.current.addressBook[0].nickname).toBe('Contact 1');
    expect(result.current.addressBook[49].nickname).toBe('Contact 50');
  });

  // ── addAddress — persist failure (#864) ──────────────────────────────────

  it('returns PERSIST_FAILED and does not commit state when localStorage throws on add', async () => {
    const realLocalStorage = window.localStorage;
    const throwingStorage = {
      ...realLocalStorage,
      getItem: (k: string) => realLocalStorage.getItem(k),
      setItem: (_k: string, _v: string) => {
        throw new DOMException('QuotaExceededError');
      },
      removeItem: (k: string) => realLocalStorage.removeItem(k),
      clear: () => realLocalStorage.clear(),
      length: 0,
      key: (_i: number) => null,
    };
    vi.stubGlobal('localStorage', throwingStorage);

    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    let r: Awaited<ReturnType<typeof result.current.addAddress>>;
    await act(async () => {
      r = await result.current.addAddress(ADDR_A, 'Acme');
    });

    vi.unstubAllGlobals();

    expect(r!).toEqual({ ok: false, error: 'PERSIST_FAILED' });
    expect(result.current.addressBook).toHaveLength(0);
  });

  // ── deleteAddress ─────────────────────────────────────────────────────────

  it('deletes address from address book', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addAddress(ADDR_A, 'Contact 1');
    });
    await act(async () => {
      await result.current.addAddress(ADDR_B, 'Contact 2');
    });
    expect(result.current.addressBook).toHaveLength(2);

    await act(async () => {
      await result.current.deleteAddress(result.current.addressBook[0].id);
    });

    expect(result.current.addressBook).toHaveLength(1);
    expect(result.current.addressBook[0].address).toBe(ADDR_B);
  });

  // ── updateAddress — success (#862 regression) ────────────────────────────

  it('updateAddress persists the new values encrypted and returns ok:true', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addAddress(ADDR_A, 'Original');
    });

    const id = result.current.addressBook[0].id;
    let r: Awaited<ReturnType<typeof result.current.updateAddress>>;
    await act(async () => {
      r = await result.current.updateAddress(id, { nickname: 'Updated' });
    });

    expect(r!).toEqual({ ok: true });
    expect(result.current.addressBook[0].nickname).toBe('Updated');

    // Verify localStorage reflects the new encrypted value.
    const raw = localStorage.getItem(`iln-address-book-${TEST_WALLET}`)!;
    const key = await deriveKeyFromWalletAddress(TEST_WALLET);
    const dec = await decryptFromStorage<typeof result.current.addressBook>(key, raw);
    expect(dec![0].nickname).toBe('Updated');
  });

  // ── updateAddress — validation (#863) ────────────────────────────────────

  it('updateAddress rejects a malformed address with INVALID_ADDRESS', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addAddress(ADDR_A, 'Original');
    });

    const id = result.current.addressBook[0].id;
    let r: Awaited<ReturnType<typeof result.current.updateAddress>>;
    await act(async () => {
      r = await result.current.updateAddress(id, { address: 'BADFORMAT' });
    });

    expect(r!).toEqual({ ok: false, error: 'INVALID_ADDRESS' });
    expect(result.current.addressBook[0].address).toBe(ADDR_A);
  });

  it('updateAddress rejects a collision with another entry with DUPLICATE_ADDRESS', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addAddress(ADDR_A, 'Alice');
    });
    await act(async () => {
      await result.current.addAddress(ADDR_B, 'Bob');
    });

    const aliceId = result.current.addressBook[0].id;
    let r: Awaited<ReturnType<typeof result.current.updateAddress>>;
    await act(async () => {
      r = await result.current.updateAddress(aliceId, { address: ADDR_B });
    });

    expect(r!).toEqual({ ok: false, error: 'DUPLICATE_ADDRESS' });
    expect(result.current.addressBook[0].address).toBe(ADDR_A);
  });

  it('updateAddress allows keeping the same address on the same entry (no self-collision)', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addAddress(ADDR_A, 'Alice');
    });

    const id = result.current.addressBook[0].id;
    let r: Awaited<ReturnType<typeof result.current.updateAddress>>;
    await act(async () => {
      r = await result.current.updateAddress(id, { address: ADDR_A, nickname: 'Alice Renamed' });
    });

    expect(r!).toEqual({ ok: true });
    expect(result.current.addressBook[0].nickname).toBe('Alice Renamed');
  });

  // ── updateAddress — persist failure (#864) ───────────────────────────────

  it('returns PERSIST_FAILED and does NOT update state when localStorage throws on update', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addAddress(ADDR_A, 'Original');
    });

    const id = result.current.addressBook[0].id;

    const realLocalStorage = window.localStorage;
    const throwingStorage = {
      ...realLocalStorage,
      getItem: (k: string) => realLocalStorage.getItem(k),
      setItem: (_k: string, _v: string) => {
        throw new DOMException('QuotaExceededError');
      },
      removeItem: (k: string) => realLocalStorage.removeItem(k),
      clear: () => realLocalStorage.clear(),
      length: 0,
      key: (_i: number) => null,
    };
    vi.stubGlobal('localStorage', throwingStorage);

    let r: Awaited<ReturnType<typeof result.current.updateAddress>>;
    await act(async () => {
      r = await result.current.updateAddress(id, { nickname: 'Should Not Persist' });
    });

    vi.unstubAllGlobals();

    expect(r!).toEqual({ ok: false, error: 'PERSIST_FAILED' });
    expect(result.current.addressBook[0].nickname).toBe('Original');
  });

  // ── searchAddresses ───────────────────────────────────────────────────────

  it('searches addresses by nickname and address (case-insensitive)', async () => {
    const { result } = renderHook(() => useAddressBook());
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(async () => {
      await result.current.addAddress(ADDR_A, 'Acme Corp');
    });
    await act(async () => {
      await result.current.addAddress(ADDR_B, 'Beta LLC');
    });
    await act(async () => {
      await result.current.addAddress(ADDR_C, 'Charlie Inc');
    });

    expect(result.current.searchAddresses('Acme')).toHaveLength(1);
    expect(result.current.searchAddresses('acme')).toHaveLength(1);
    expect(result.current.searchAddresses('BBBB')).toHaveLength(1);
    expect(result.current.searchAddresses('XYZ')).toHaveLength(0);
    expect(result.current.searchAddresses('')).toHaveLength(3);
  });
});
