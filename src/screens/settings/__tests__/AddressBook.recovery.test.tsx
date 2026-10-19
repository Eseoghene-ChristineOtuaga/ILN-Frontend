/**
 * Integration test: a tampered stored address book is never rendered, and the
 * user sees an accessible, dismissible recovery notice instead (#1097).
 * Renders against the real useAddressBook hook and record store.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AddressBookPage from '../AddressBook';
import {
  currentWalletRecordScope,
  walletRecordKey,
  writeWalletRecord,
} from '@/utils/walletRecordStore';

const { TEST_WALLET } = vi.hoisted(() => ({
  TEST_WALLET: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC',
}));

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

const scope = currentWalletRecordScope(TEST_WALLET);
const key = walletRecordKey('address-book', scope);

describe('AddressBookPage storage recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('does not render tampered entries and shows a dismissible alert', () => {
    writeWalletRecord(
      'address-book',
      scope,
      [{ id: 'a', address: 'GALICEADDRESS', nickname: 'Alice' }],
      { storage: localStorage }
    );
    const envelope = JSON.parse(localStorage.getItem(key)!);
    envelope.data[0].nickname = 'Mallory';
    localStorage.setItem(key, JSON.stringify(envelope));

    render(<AddressBookPage />);

    expect(screen.queryByText('Mallory')).not.toBeInTheDocument();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('addressBook.recovery.title');
    expect(alert).toHaveTextContent('addressBook.recovery.TAMPERED');

    fireEvent.click(screen.getByRole('button', { name: 'addressBook.recovery.dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows no alert for a valid record', () => {
    writeWalletRecord(
      'address-book',
      scope,
      [{ id: 'a', address: 'GALICEADDRESS', nickname: 'Alice' }],
      { storage: localStorage }
    );
    render(<AddressBookPage />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
