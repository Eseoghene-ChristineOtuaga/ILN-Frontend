/**
 * AddressBook component tests
 *
 * Covers:
 *  - #862  edit-save-rerender regression (edit → save → new value displayed)
 *  - #863  address-format and duplicate-entry validation on add and save
 *  - #864  save-failure handling: error toast shown, edit form stays open
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AddressBookPage from '../AddressBook';
import type { AddressBookResult } from '@/hooks/useAddressBook';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));

const addToastMock = vi.fn();
vi.mock('@/context/ToastContext', () => ({
  useToast: () => ({ addToast: addToastMock }),
}));

const addAddressMock = vi.fn(() => true);
const deleteAddressMock = vi.fn();
const searchAddressesMock = vi.fn();
const retryHydrationMock = vi.fn();
const clearCorruptedStateMock = vi.fn();

const { mockState } = vi.hoisted(() => ({
  mockState: {
    addressBook: [
      {
        id: '1',
        address: 'GALICEALICEALICEALICEALICEALICEALICEALICEALICEALICEALICE12',
        nickname: 'Alice',
      },
      {
        id: '2',
        address: 'GBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOB1234',
        nickname: 'Bob',
      },
    ] as Array<{ id: string; address: string; nickname: string }>,
    addAddress: vi.fn<[string, string], AddressBookResult>(() => ({ ok: true })),
    updateAddress: vi.fn<
      [string, Partial<{ address: string; nickname: string }>],
      AddressBookResult
    >(() => ({ ok: true })),
    deleteAddress: vi.fn<[string], void>(),
    searchAddresses: vi.fn<[string], Array<{ id: string; address: string; nickname: string }>>(),
  },
}));

let mockHookState: Record<string, unknown> = {
  addressBook,
  addAddress: addAddressMock,
  deleteAddress: deleteAddressMock,
  searchAddresses: searchAddressesMock,
  isLoading: false,
  isDegraded: false,
  error: null,
  validationIssues: null,
  retryHydration: retryHydrationMock,
  clearCorruptedState: clearCorruptedStateMock,
};

vi.mock('@/hooks/useAddressBook', () => ({
  default: () => mockHookState,
}));

// ── Valid Stellar addresses used throughout tests ─────────────────────────────

const VALID_ADDRESS_ALICE = 'GALICEALICEALICEALICEALICEALICEALICEALICEALICEALICEALICE12';
const VALID_ADDRESS_BOB = 'GBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOBBOB1234';
const VALID_ADDRESS_CAROL = 'GCAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCAROLCARO12';

describe('AddressBookPage', () => {
  beforeEach(() => {
    addToastMock.mockClear();
    updateToastMock.mockClear();
    addAddressMock.mockReset();
    addAddressMock.mockReturnValue(true);
    deleteAddressMock.mockClear();
    retryHydrationMock.mockClear();
    clearCorruptedStateMock.mockClear();
    searchAddressesMock.mockReset();
    searchAddressesMock.mockReturnValue(addressBook);

    mockHookState = {
      addressBook,
      addAddress: addAddressMock,
      deleteAddress: deleteAddressMock,
      searchAddresses: searchAddressesMock,
      isLoading: false,
      isDegraded: false,
      error: null,
      validationIssues: null,
      retryHydration: retryHydrationMock,
      clearCorruptedState: clearCorruptedStateMock,
    };
  });

  // ── Rendering ───────────────────────────────────────────────────────────────

  it('renders each address book entry with its truncated address', () => {
    render(<AddressBookPage />);
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('shows an empty state when there are no matching addresses', () => {
    mockState.searchAddresses.mockReturnValue([]);
    render(<AddressBookPage />);
    expect(screen.getByText('addressBook.noAddresses')).toBeInTheDocument();
  });

  // ── Add validation (#863) ────────────────────────────────────────────────────

  it('shows missingFields error when adding without both fields', () => {
    mockState.addAddress.mockReturnValue({ ok: false, error: 'MISSING_FIELDS' });
    render(<AddressBookPage />);
    fireEvent.click(screen.getByText('addressBook.addAddress'));
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'addressBook.errors.missingFields' })
    );
    expect(mockState.addAddress).toHaveBeenCalledWith('', '');
  });

  it('shows invalidAddress error when address format is wrong', () => {
    mockState.addAddress.mockReturnValue({ ok: false, error: 'INVALID_ADDRESS' });
    render(<AddressBookPage />);
    fireEvent.change(screen.getByPlaceholderText('addressBook.stellarAddressPlaceholder'), {
      target: { value: 'NOT-A-STELLAR-ADDRESS' },
    });
    fireEvent.change(screen.getByPlaceholderText('addressBook.nicknamePlaceholder'), {
      target: { value: 'Bad Addr' },
    });
    fireEvent.click(screen.getByText('addressBook.addAddress'));
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'addressBook.errors.invalidAddress' })
    );
  });

  it('shows duplicateAddress error when address already exists', () => {
    mockState.addAddress.mockReturnValue({ ok: false, error: 'DUPLICATE_ADDRESS' });
    render(<AddressBookPage />);
    fireEvent.change(screen.getByPlaceholderText('addressBook.stellarAddressPlaceholder'), {
      target: { value: VALID_ADDRESS_ALICE },
    });
    fireEvent.change(screen.getByPlaceholderText('addressBook.nicknamePlaceholder'), {
      target: { value: 'Duplicate' },
    });
    fireEvent.click(screen.getByText('addressBook.addAddress'));
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'addressBook.errors.duplicateAddress' })
    );
  });

  it('adds a new address and clears the form on success', () => {
    render(<AddressBookPage />);
    fireEvent.change(screen.getByPlaceholderText('addressBook.stellarAddressPlaceholder'), {
      target: { value: VALID_ADDRESS_CAROL },
    });
    fireEvent.change(screen.getByPlaceholderText('addressBook.nicknamePlaceholder'), {
      target: { value: 'Carol' },
    });
    fireEvent.click(screen.getByText('addressBook.addAddress'));

    expect(mockState.addAddress).toHaveBeenCalledWith(VALID_ADDRESS_CAROL, 'Carol');
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: 'addressBook.success.added' })
    );
    // Form inputs should be cleared after a successful add
    expect(screen.getByPlaceholderText('addressBook.stellarAddressPlaceholder')).toHaveValue('');
    expect(screen.getByPlaceholderText('addressBook.nicknamePlaceholder')).toHaveValue('');
  });

  it('shows error toast when adding invalid address format fails validation', () => {
    addAddressMock.mockReturnValue(false);
    render(<AddressBookPage />);

    fireEvent.change(screen.getByPlaceholderText('addressBook.stellarAddressPlaceholder'), {
      target: { value: 'invalid address with spaces' },
    });
    fireEvent.change(screen.getByPlaceholderText('addressBook.nicknamePlaceholder'), {
      target: { value: 'Bad Format' },
    });
    fireEvent.click(screen.getByText('addressBook.addAddress'));

    expect(addAddressMock).toHaveBeenCalled();
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Invalid address or format rejected' })
    );
  });

  it('deletes an address', () => {
    render(<AddressBookPage />);
    fireEvent.click(screen.getAllByTitle('addressBook.edit')[0]);

    expect(screen.getByLabelText('addressBook.editAddressLabel')).toHaveValue(VALID_ADDRESS_ALICE);
    expect(screen.getByLabelText('addressBook.editNicknameLabel')).toHaveValue('Alice');
  });

  it('saves the edited values and shows a success toast', () => {
    render(<AddressBookPage />);
    // Enter edit mode for the first entry (Alice)
    fireEvent.click(screen.getAllByTitle('addressBook.edit')[0]);

    // Change both fields
    fireEvent.change(screen.getByLabelText('addressBook.editAddressLabel'), {
      target: { value: VALID_ADDRESS_CAROL },
    });
    fireEvent.change(screen.getByLabelText('addressBook.editNicknameLabel'), {
      target: { value: 'Alice Renamed' },
    });

    // Simulate hook writing the new values into addressBook state
    mockState.addressBook = [
      { id: '1', address: VALID_ADDRESS_CAROL, nickname: 'Alice Renamed' },
      { id: '2', address: VALID_ADDRESS_BOB, nickname: 'Bob' },
    ];
    mockState.searchAddresses.mockImplementation(() => mockState.addressBook);

    fireEvent.click(screen.getByText('addressBook.save'));

    expect(mockState.updateAddress).toHaveBeenCalledWith('1', {
      address: VALID_ADDRESS_CAROL,
      nickname: 'Alice Renamed',
    });
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: 'addressBook.success.updated' })
    );
    // Edit form should close after a successful save
    expect(screen.queryByText('addressBook.save')).not.toBeInTheDocument();
  });

  it('edit-save-rerender: re-render shows the new nickname after save', () => {
    const { rerender } = render(<AddressBookPage />);
    fireEvent.click(screen.getAllByTitle('addressBook.edit')[0]);
    fireEvent.change(screen.getByLabelText('addressBook.editNicknameLabel'), {
      target: { value: 'Alice Updated' },
    });

    // Simulate the hook updating its state after updateAddress
    mockState.addressBook = [
      { id: '1', address: VALID_ADDRESS_ALICE, nickname: 'Alice Updated' },
      { id: '2', address: VALID_ADDRESS_BOB, nickname: 'Bob' },
    ];
    mockState.searchAddresses.mockImplementation(() => mockState.addressBook);

    fireEvent.click(screen.getByText('addressBook.save'));

    // Re-render with the updated hook state
    rerender(<AddressBookPage />);

    expect(screen.getByText('Alice Updated')).toBeInTheDocument();
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });

  it('cancel leaves the entry unchanged', () => {
    render(<AddressBookPage />);
    fireEvent.click(screen.getAllByTitle('addressBook.edit')[0]);
    fireEvent.change(screen.getByLabelText('addressBook.editNicknameLabel'), {
      target: { value: 'Should Not Persist' },
    });
    fireEvent.click(screen.getByText('addressBook.cancel'));

    // Edit form should be gone
    expect(screen.queryByText('addressBook.save')).not.toBeInTheDocument();
    // updateAddress should never have been called
    expect(mockState.updateAddress).not.toHaveBeenCalled();
  });

  // ── Save-failure rollback (#864) ─────────────────────────────────────────────

  it('shows saveFailed error and keeps the edit form open when update persistence fails', () => {
    mockState.updateAddress.mockReturnValue({ ok: false, error: 'PERSIST_FAILED' });

    render(<AddressBookPage />);
    fireEvent.click(screen.getAllByTitle('addressBook.edit')[0]);
    fireEvent.click(screen.getByText('addressBook.save'));

    // Error toast shown
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'addressBook.errors.saveFailed' })
    );
    // Edit form stays open so the user can retry — success toast NOT shown
    expect(screen.getByText('addressBook.save')).toBeInTheDocument();
    expect(addToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'success' }));
  });

  it('shows saveFailed error and keeps add form values when add persistence fails', () => {
    mockState.addAddress.mockReturnValue({ ok: false, error: 'PERSIST_FAILED' });

    render(<AddressBookPage />);
    fireEvent.change(screen.getByPlaceholderText('addressBook.stellarAddressPlaceholder'), {
      target: { value: VALID_ADDRESS_CAROL },
    });
    fireEvent.change(screen.getByPlaceholderText('addressBook.nicknamePlaceholder'), {
      target: { value: 'Carol' },
    });
    fireEvent.click(screen.getByText('addressBook.addAddress'));

    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'addressBook.errors.saveFailed' })
    );
    // Form values are preserved so the user does not have to re-type
    expect(screen.getByPlaceholderText('addressBook.stellarAddressPlaceholder')).toHaveValue(
      VALID_ADDRESS_CAROL
    );
    expect(screen.getByPlaceholderText('addressBook.nicknamePlaceholder')).toHaveValue('Carol');
  });

  it('shows invalidAddress error when saving an edit with a bad format', () => {
    mockState.updateAddress.mockReturnValue({ ok: false, error: 'INVALID_ADDRESS' });

    render(<AddressBookPage />);
    fireEvent.click(screen.getAllByTitle('addressBook.edit')[0]);
    fireEvent.change(screen.getByLabelText('addressBook.editAddressLabel'), {
      target: { value: 'BADFORMAT' },
    });
    fireEvent.click(screen.getByText('addressBook.save'));

    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'addressBook.errors.invalidAddress' })
    );
    // Edit form stays open
    expect(screen.getByText('addressBook.save')).toBeInTheDocument();
  });

  it('shows duplicateAddress error when saving an edit that collides with another entry', () => {
    mockState.updateAddress.mockReturnValue({ ok: false, error: 'DUPLICATE_ADDRESS' });

    render(<AddressBookPage />);
    fireEvent.click(screen.getAllByTitle('addressBook.edit')[0]);
    fireEvent.change(screen.getByLabelText('addressBook.editAddressLabel'), {
      target: { value: VALID_ADDRESS_BOB },
    });
    fireEvent.click(screen.getByText('addressBook.save'));

    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'addressBook.errors.duplicateAddress' })
    );
    expect(screen.getByText('addressBook.save')).toBeInTheDocument();
  });

  // ── Delete ───────────────────────────────────────────────────────────────────

  it('deletes an address', () => {
    render(<AddressBookPage />);
    fireEvent.click(screen.getAllByTitle('addressBook.delete')[0]);
    expect(mockState.deleteAddress).toHaveBeenCalledWith('1');
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: 'addressBook.success.deleted' })
    );
  });

  // ── Search ───────────────────────────────────────────────────────────────────

  it('updates the search query and shows a filtered count when it differs from the full list', () => {
    mockState.searchAddresses.mockReturnValue([mockState.addressBook[0]]);
    render(<AddressBookPage />);
    fireEvent.change(screen.getByPlaceholderText('addressBook.searchPlaceholder'), {
      target: { value: 'Alice' },
    });
    expect(mockState.searchAddresses).toHaveBeenCalledWith('Alice');
  });

  it('displays a warning banner when storage is in degraded mode', () => {
    mockHookState.isDegraded = true;
    render(<AddressBookPage />);
    expect(screen.getByRole('status')).toHaveTextContent(/safe degraded mode/i);
  });

  it('displays an error alert with retry and reset recovery actions on hydration error', () => {
    mockHookState.error =
      'Wallet ownership mismatch: stored address book does not belong to active wallet.';
    render(<AddressBookPage />);

    expect(screen.getByRole('alert')).toHaveTextContent(/Wallet ownership mismatch/i);

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(retryHydrationMock).toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /reset/i }));
    expect(clearCorruptedStateMock).toHaveBeenCalled();
  });

  it('displays validation issues banner when records are excluded during hydration', () => {
    mockHookState.validationIssues = {
      rejectedCount: 2,
      reasons: ['Unknown fields', 'Malformed address'],
    };
    render(<AddressBookPage />);

    expect(
      screen.getByText(/2 malformed record\(s\) excluded during validation/i)
    ).toBeInTheDocument();
  });
});
