/**
 * useAddressBook tamper/expiry/isolation recovery (#1087, #1088, #1089, #1097).
 *
 * Deterministic fixtures: a fixed system clock and fixed wallet addresses.
 */
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import useAddressBook from '../useAddressBook';
import {
  currentWalletRecordScope,
  WALLET_RECORD_RETENTION_MS,
  walletRecordKey,
  writeWalletRecord,
} from '@/utils/walletRecordStore';

const { wallet } = vi.hoisted(() => ({
  wallet: { address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC' as string | null },
}));

vi.mock('@/context/WalletContext', () => ({
  useWallet: () => ({ address: wallet.address }),
}));

const WALLET_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC';
const WALLET_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD';
const CONTACT = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCBE';
const NOW = Date.UTC(2026, 0, 1);
const RETENTION = WALLET_RECORD_RETENTION_MS['address-book'];
const ENTRIES = [{ id: '1', address: CONTACT, nickname: 'Carol' }];

const keyFor = (w: string) => walletRecordKey('address-book', currentWalletRecordScope(w));
const seed = (w: string, data: unknown = ENTRIES, now = NOW) =>
  writeWalletRecord('address-book', currentWalletRecordScope(w), data, {
    storage: localStorage,
    now,
  });

describe('useAddressBook storage recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    wallet.address = WALLET_A;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads a valid record with status ready and no recovery notice', () => {
    seed(WALLET_A);
    const { result } = renderHook(() => useAddressBook());
    expect(result.current.status).toBe('ready');
    expect(result.current.recovery).toBeNull();
    expect(result.current.addressBook).toEqual(ENTRIES);
  });

  it('reports idle with no wallet connected', () => {
    wallet.address = null;
    const { result } = renderHook(() => useAddressBook());
    expect(result.current.status).toBe('idle');
    expect(result.current.addressBook).toEqual([]);
  });

  it.each([
    [
      'TAMPERED',
      () => {
        seed(WALLET_A);
        const env = JSON.parse(localStorage.getItem(keyFor(WALLET_A))!);
        env.data[0].address = WALLET_B; // redirect payments to another address
        localStorage.setItem(keyFor(WALLET_A), JSON.stringify(env));
      },
    ],
    ['CORRUPT', () => localStorage.setItem(keyFor(WALLET_A), '{not json')],
    ['EXPIRED', () => seed(WALLET_A, ENTRIES, NOW - RETENTION)],
    [
      'SCOPE_MISMATCH',
      () => {
        seed(WALLET_B);
        localStorage.setItem(keyFor(WALLET_A), localStorage.getItem(keyFor(WALLET_B))!);
      },
    ],
    ['INVALID_SHAPE', () => seed(WALLET_A, [{ id: 1 }])],
  ])('discards a %s record, surfaces the reason and removes it', (reason, arrange) => {
    arrange();
    const { result } = renderHook(() => useAddressBook());

    expect(result.current.status).toBe('ready');
    expect(result.current.recovery).toBe(reason);
    expect(result.current.addressBook).toEqual([]);
    expect(localStorage.getItem(keyFor(WALLET_A))).toBeNull();
  });

  it('recovers: the user can save new entries after a discard and dismiss the notice', () => {
    localStorage.setItem(keyFor(WALLET_A), 'garbage');
    const { result, rerender } = renderHook(() => useAddressBook());
    expect(result.current.recovery).toBe('CORRUPT');

    act(() => {
      expect(result.current.addAddress(CONTACT, 'Carol')).toEqual({ ok: true });
    });
    act(() => result.current.dismissRecovery());
    expect(result.current.recovery).toBeNull();

    rerender();
    const stored = JSON.parse(localStorage.getItem(keyFor(WALLET_A))!);
    expect(stored.data).toHaveLength(1);
    expect(stored.data[0].nickname).toBe('Carol');
  });

  it('reports unavailable when storage reads throw and keeps an empty book', () => {
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { result } = renderHook(() => useAddressBook());
    expect(result.current.status).toBe('unavailable');
    expect(result.current.recovery).toBeNull();
    expect(result.current.addressBook).toEqual([]);
  });

  it('refreshes the retention window when the address book is loaded', () => {
    seed(WALLET_A, ENTRIES, NOW - RETENTION / 2);
    renderHook(() => useAddressBook());
    const stored = JSON.parse(localStorage.getItem(keyFor(WALLET_A))!);
    expect(stored.savedAt).toBe(NOW);
    expect(stored.expiresAt).toBe(NOW + RETENTION);
  });

  it('isolates address books per wallet when the connected wallet changes', () => {
    seed(WALLET_A);
    const { result, rerender } = renderHook(() => useAddressBook());
    expect(result.current.addressBook).toEqual(ENTRIES);

    wallet.address = WALLET_B;
    rerender();
    expect(result.current.addressBook).toEqual([]);
    expect(result.current.recovery).toBeNull();

    act(() => {
      result.current.addAddress(WALLET_A, 'Alice');
    });
    wallet.address = WALLET_A;
    rerender();
    expect(result.current.addressBook).toEqual(ENTRIES);
  });
});
