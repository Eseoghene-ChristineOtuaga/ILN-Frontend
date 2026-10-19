/**
 * Integration test for the AddressBook inline-edit flow (issue #860).
 *
 * Unlike AddressBook.test.tsx, this suite renders the page against the real
 * useAddressBook hook and jsdom's localStorage, so it proves an edit is not
 * only dispatched but actually persisted and survives a remount.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AddressBookPage from '../AddressBook';
import { currentWalletRecordScope, walletRecordKey } from '@/utils/walletRecordStore';

// vi.mock is hoisted above module-level consts, so the address is hoisted too.
const { TEST_WALLET } = vi.hoisted(() => ({
  TEST_WALLET: 'GDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXABCD',
}));
// Seeded at the pre-envelope key; the hook migrates it to the scoped key on load.
const LEGACY_STORAGE_KEY = `iln-address-book-${TEST_WALLET}`;

vi.mock('@/context/WalletContext', () => ({
  useWallet: () => ({ address: TEST_WALLET }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ addToast: vi.fn(() => 'toast-id'), updateToast: vi.fn() }),
}));

const seedEntries = [
  { id: 'a', address: 'GALICEADDRESS1234567890', nickname: 'Alice' },
  { id: 'b', address: 'GBOBADDRESS12345678901', nickname: 'Bob' },
];

function storedEntries() {
  const key = walletRecordKey('address-book', currentWalletRecordScope(TEST_WALLET));
  const raw = localStorage.getItem(key);
  return raw ? JSON.parse(raw).data : [];
}

describe('AddressBookPage inline edit persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(seedEntries));
  });

  it('persists an edited entry to localStorage and shows it after a remount', () => {
    const { unmount } = render(<AddressBookPage />);

    fireEvent.click(screen.getAllByTitle('addressBook.edit')[0]);
    fireEvent.change(screen.getByLabelText('addressBook.editAddressLabel'), {
      target: { value: 'GALICENEWADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA6543' },
    });
    fireEvent.change(screen.getByLabelText('addressBook.editNicknameLabel'), {
      target: { value: 'Alice Treasury' },
    });
    fireEvent.click(screen.getByText('addressBook.save'));

    // Rendered list reflects the edit immediately.
    expect(screen.getByText('Alice Treasury')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();

    // Storage holds the new values; id and untouched entries are preserved.
    expect(storedEntries()).toEqual([
      {
        id: 'a',
        address: 'GALICENEWADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA6543',
        nickname: 'Alice Treasury',
      },
      seedEntries[1],
    ]);

    // A fresh mount reads the edited entry back out of storage.
    unmount();
    render(<AddressBookPage />);
    expect(screen.getByText('Alice Treasury')).toBeInTheDocument();
    expect(screen.getByText('GALICE...6543')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('leaves storage untouched when an edit is cancelled', () => {
    render(<AddressBookPage />);

    fireEvent.click(screen.getAllByTitle('addressBook.edit')[1]);
    fireEvent.change(screen.getByLabelText('addressBook.editNicknameLabel'), {
      target: { value: 'Not Bob' },
    });
    fireEvent.click(screen.getByText('addressBook.cancel'));

    expect(screen.getByText('Bob')).toBeInTheDocument();
    expect(storedEntries()).toEqual(seedEntries);
  });
});
