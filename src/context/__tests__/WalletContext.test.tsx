/**
 * @file WalletContext.test.tsx
 *
 * Exercises the wallet connect/disconnect/silent-reconnect/network-mismatch
 * detection/role-detection/tx-signing context that nearly every page depends
 * on. `@stellar/freighter-api` is mocked locally (overriding the global
 * disconnected-by-default mock from vitest.setup.ts) so each test controls
 * exactly what the "extension" reports back.
 */

import React, { useState } from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  isConnected,
  getAddress,
  setAllowed,
  signTransaction,
  getNetwork,
  requestAccess,
} from '@stellar/freighter-api';
import { WalletProvider, useWallet } from '../WalletContext';
import { WALLET_ADDRESS_STORAGE_KEY, WALLET_PROVIDER_STORAGE_KEY } from '@/utils/walletStorage';
import { getWalletRoles } from '@/utils/soroban';
import { trackEvent } from '@/lib/analytics';
import { authenticateWithSep10, Sep10Error } from '@/utils/sep10';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('@stellar/freighter-api', () => ({
  isConnected: vi.fn(),
  getAddress: vi.fn(),
  setAllowed: vi.fn(),
  signTransaction: vi.fn(),
  getNetwork: vi.fn(),
  requestAccess: vi.fn(),
}));

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

const addToastMock = vi.fn(() => 'toast-id');
const updateToastMock = vi.fn();
vi.mock('../ToastContext', () => ({
  useToast: () => ({ addToast: addToastMock, updateToast: updateToastMock }),
}));

vi.mock('@/utils/soroban', () => ({
  getWalletRoles: vi.fn(),
}));

vi.mock('@/lib/analytics', () => ({
  trackEvent: vi.fn(),
}));

const sep10Mocks = vi.hoisted(() => ({
  authenticateWithSep10: vi.fn(),
  authenticatedFetch: vi.fn(),
}));

vi.mock('@/utils/sep10', () => ({
  ...sep10Mocks,
  Sep10Error: class Sep10Error extends Error {
    code: string;

    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

// The real modal pulls in QR code rendering + a focus trap; a light stub lets
// tests drive `connect()`'s provider-selection step deterministically.
vi.mock('@/components/WalletSelectionModal', () => ({
  __esModule: true,
  default: ({
    onClose,
    onSelectFreighter,
    onSelectWalletConnect,
  }: {
    onClose: () => void;
    onSelectFreighter: () => void;
    onSelectWalletConnect: () => void;
  }) => (
    <div data-testid="wallet-modal">
      <button onClick={onSelectFreighter}>select-freighter</button>
      <button onClick={onSelectWalletConnect}>select-walletconnect</button>
      <button onClick={onClose}>close-modal</button>
    </div>
  ),
}));

// ─── Test harness ─────────────────────────────────────────────────────────────

const ADDRESS = 'GCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC6';

function TestConsumer() {
  const wallet = useWallet();
  const [signResult, setSignResult] = useState<string>('none');
  const [requestResult, setRequestResult] = useState<string>('none');

  return (
    <div>
      <div data-testid="address">{wallet.address ?? 'none'}</div>
      <div data-testid="isConnected">{String(wallet.isConnected)}</div>
      <div data-testid="isInstalled">{String(wallet.isInstalled)}</div>
      <div data-testid="isReconnecting">{String(wallet.isReconnecting)}</div>
      <div data-testid="preferredProvider">{wallet.preferredWalletProvider ?? 'none'}</div>
      <div data-testid="error">{wallet.error ?? 'none'}</div>
      <div data-testid="networkMismatch">{String(wallet.networkMismatch)}</div>
      <div data-testid="rpcMismatch">{String(wallet.rpcMismatch)}</div>
      <div data-testid="walletNetwork">{wallet.walletNetwork ?? 'none'}</div>
      <div data-testid="switchingNetwork">{String(wallet.switchingNetwork)}</div>
      <div data-testid="roles">{wallet.roles.join(',') || 'none'}</div>
      <div data-testid="rolesLoading">{String(wallet.rolesLoading)}</div>
      <div data-testid="authStatus">{wallet.authStatus}</div>
      <div data-testid="authError">{wallet.authError?.message ?? 'none'}</div>
      <div data-testid="requestResult">{requestResult}</div>
      <div data-testid="signResult">{signResult}</div>
      <button onClick={() => void wallet.connect()}>connect</button>
      <button onClick={() => wallet.disconnect()}>disconnect</button>
      <button onClick={() => void wallet.switchNetwork()}>switchNetwork</button>
      <button
        onClick={() => {
          void wallet.authenticate().catch(() => {});
        }}
      >
        authenticate
      </button>
      <button
        onClick={() => {
          void wallet
            .authenticatedRequest('https://api.example.com/private')
            .then(() => setRequestResult('success'))
            .catch((requestError: unknown) => {
              setRequestResult(
                requestError instanceof Error ? requestError.message : 'unexpected failure'
              );
            });
        }}
      >
        authenticatedRequest
      </button>
      <button
        onClick={async () => {
          try {
            const signed = await wallet.signTx('raw-xdr');
            setSignResult(signed);
          } catch (e: unknown) {
            setSignResult(`ERROR:${(e as Error).message}`);
          }
        }}
      >
        signTx
      </button>
    </div>
  );
}

function renderWallet() {
  return render(
    <WalletProvider>
      <TestConsumer />
    </WalletProvider>
  );
}

/** Drives `connect()` -> opens the stub modal -> selects Freighter. */
async function connectViaFreighter() {
  fireEvent.click(screen.getByRole('button', { name: 'connect' }));
  const modalButton = await screen.findByRole('button', { name: 'select-freighter' });
  fireEvent.click(modalButton);
}

const mockedIsConnected = vi.mocked(isConnected);
const mockedGetAddress = vi.mocked(getAddress);
const mockedSetAllowed = vi.mocked(setAllowed);
const mockedSignTransaction = vi.mocked(signTransaction);
const mockedGetNetwork = vi.mocked(getNetwork);
const mockedRequestAccess = vi.mocked(requestAccess);
const mockedGetWalletRoles = vi.mocked(getWalletRoles);
const mockedTrackEvent = vi.mocked(trackEvent);
const mockedAuthenticateWithSep10 = vi.mocked(authenticateWithSep10);

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();

  mockedIsConnected.mockResolvedValue({ isConnected: false });
  mockedGetAddress.mockResolvedValue({ address: null } as any);
  mockedSetAllowed.mockResolvedValue({ isAllowed: false });
  mockedSignTransaction.mockResolvedValue({ signedTxXdr: '' } as any);
  mockedGetNetwork.mockResolvedValue({ network: 'TESTNET', networkPassphrase: '' } as any);
  mockedRequestAccess.mockResolvedValue({ address: '' } as any);
  mockedGetWalletRoles.mockResolvedValue([]);
  mockedAuthenticateWithSep10.mockImplementation(async (options) => {
    await options.assertWalletIdentity();
    return {
      token: 'valid.jwt.token',
      address: options.address,
      domain: 'example.com',
      authOrigin: 'https://auth.example.com',
      network: options.network,
      expiresAt: Date.now() + 60_000,
    };
  });
  sep10Mocks.authenticatedFetch.mockReset();
  addToastMock.mockClear();
  updateToastMock.mockClear();
  pushMock.mockClear();

  vi.spyOn(window, 'open').mockImplementation(() => null);
  delete (window as any).stellar;
  delete (window as any).freighter;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as any).stellar;
  delete (window as any).freighter;
});

// ─── useWallet() guard ──────────────────────────────────────────────────────

describe('useWallet()', () => {
  it('throws when used outside a WalletProvider', () => {
    // Swallow the expected React error-boundary console.error noise.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow(
      'useWallet must be used within a WalletProvider'
    );
    consoleErrorSpy.mockRestore();
  });
});

// ─── Silent reconnect on mount ─────────────────────────────────────────────────

describe('silent reconnect on mount', () => {
  it('does nothing when no wallet provider was previously saved', async () => {
    renderWallet();

    await waitFor(() => expect(screen.getByTestId('isReconnecting').textContent).toBe('false'));
    expect(screen.getByTestId('preferredProvider').textContent).toBe('none');
    expect(screen.getByTestId('address').textContent).toBe('none');
  });

  it('restores the session when freighter was the saved provider and is installed', async () => {
    localStorage.setItem(WALLET_PROVIDER_STORAGE_KEY, 'freighter');
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);

    renderWallet();

    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));
    expect(screen.getByTestId('preferredProvider').textContent).toBe('freighter');
    expect(localStorage.getItem(WALLET_ADDRESS_STORAGE_KEY)).toBe(ADDRESS);
    await waitFor(() => expect(screen.getByTestId('isReconnecting').textContent).toBe('false'));
  });

  it('clears storage when freighter was saved but is no longer installed', async () => {
    localStorage.setItem(WALLET_PROVIDER_STORAGE_KEY, 'freighter');
    localStorage.setItem(WALLET_ADDRESS_STORAGE_KEY, ADDRESS);
    mockedIsConnected.mockResolvedValue({ isConnected: false });

    renderWallet();

    await waitFor(() => expect(screen.getByTestId('isReconnecting').textContent).toBe('false'));
    expect(screen.getByTestId('preferredProvider').textContent).toBe('none');
    expect(localStorage.getItem(WALLET_PROVIDER_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(WALLET_ADDRESS_STORAGE_KEY)).toBeNull();
  });

  it('clears storage when freighter reports installed but returns no address', async () => {
    localStorage.setItem(WALLET_PROVIDER_STORAGE_KEY, 'freighter');
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedGetAddress.mockResolvedValue({ address: null } as any);

    renderWallet();

    await waitFor(() => expect(screen.getByTestId('isReconnecting').textContent).toBe('false'));
    expect(screen.getByTestId('preferredProvider').textContent).toBe('none');
    expect(screen.getByTestId('address').textContent).toBe('none');
  });

  it('clears storage and surfaces no crash when the reconnect attempt throws', async () => {
    localStorage.setItem(WALLET_PROVIDER_STORAGE_KEY, 'freighter');
    mockedIsConnected.mockRejectedValue(new Error('extension crashed'));

    renderWallet();

    await waitFor(() => expect(screen.getByTestId('isReconnecting').textContent).toBe('false'));
    expect(screen.getByTestId('preferredProvider').textContent).toBe('none');
    expect(localStorage.getItem(WALLET_PROVIDER_STORAGE_KEY)).toBeNull();
  });

  it('records a non-freighter saved provider (e.g. walletconnect) without reconnecting', async () => {
    localStorage.setItem(WALLET_PROVIDER_STORAGE_KEY, 'walletconnect');

    renderWallet();

    await waitFor(() =>
      expect(screen.getByTestId('preferredProvider').textContent).toBe('walletconnect')
    );
    // Never enters the reconnecting state because of the early return.
    expect(screen.getByTestId('isReconnecting').textContent).toBe('false');
  });
});

// ─── checkConnection (independent of the saved-provider reconnect flow) ───────

describe('checkConnection on mount', () => {
  it('reflects installed + address even with no saved provider', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);

    renderWallet();

    await waitFor(() => expect(screen.getByTestId('isInstalled').textContent).toBe('true'));
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));
  });

  it('leaves isInstalled false when the extension is not present', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: false });

    renderWallet();

    await waitFor(() => expect(screen.getByTestId('isReconnecting').textContent).toBe('false'));
    expect(screen.getByTestId('isInstalled').textContent).toBe('false');
    expect(screen.getByTestId('address').textContent).toBe('none');
  });

  it('accepts a bare boolean return shape from isConnected()', async () => {
    mockedIsConnected.mockResolvedValue(true as any);
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);

    renderWallet();

    await waitFor(() => expect(screen.getByTestId('isInstalled').textContent).toBe('true'));
  });

  it('swallows errors from a failing checkConnection call', async () => {
    mockedIsConnected.mockRejectedValue(new Error('boom'));

    renderWallet();

    await waitFor(() => expect(screen.getByTestId('isReconnecting').textContent).toBe('false'));
    expect(screen.getByTestId('isInstalled').textContent).toBe('false');
  });

  it('treats an unrecognized isConnected() return shape as not installed', async () => {
    // Neither a boolean nor an object with an `isConnected` key - exercises
    // extractConnectionState()'s final `return false` fallback.
    mockedIsConnected.mockResolvedValue({ unexpected: true } as any);

    renderWallet();

    await waitFor(() => expect(screen.getByTestId('isReconnecting').textContent).toBe('false'));
    expect(screen.getByTestId('isInstalled').textContent).toBe('false');
  });
});

// ─── connect() ──────────────────────────────────────────────────────────────

describe('connect()', () => {
  it('opens the provider-selection modal', async () => {
    renderWallet();
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));
    expect(await screen.findByTestId('wallet-modal')).toBeInTheDocument();
  });

  it('closes the modal without connecting', async () => {
    renderWallet();
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));
    const closeButton = await screen.findByRole('button', { name: 'close-modal' });
    fireEvent.click(closeButton);
    await waitFor(() => expect(screen.queryByTestId('wallet-modal')).not.toBeInTheDocument());
    expect(screen.getByTestId('address').textContent).toBe('none');
  });

  it('connects successfully, stores the address, and tracks the event', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);

    renderWallet();
    await connectViaFreighter();

    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));
    expect(screen.getByTestId('preferredProvider').textContent).toBe('freighter');
    expect(localStorage.getItem(WALLET_ADDRESS_STORAGE_KEY)).toBe(ADDRESS);
    expect(localStorage.getItem(WALLET_PROVIDER_STORAGE_KEY)).toBe('freighter');
    expect(mockedTrackEvent).toHaveBeenCalledWith('wallet_connected', {
      provider: 'freighter',
      network: 'TESTNET',
    });
    expect(updateToastMock).toHaveBeenCalledWith(
      'toast-id',
      expect.objectContaining({ type: 'success' })
    );
    expect(screen.getByTestId('networkMismatch').textContent).toBe('false');
  });

  it('accepts bare boolean shapes from setAllowed() and isConnected()', async () => {
    mockedIsConnected.mockResolvedValue(true as any);
    mockedSetAllowed.mockResolvedValue(true as any);
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue('TESTNET' as any);

    renderWallet();
    await connectViaFreighter();

    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));
  });

  it('surfaces an install prompt and opens freighter.app when not installed', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: false });

    renderWallet();
    await connectViaFreighter();

    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe(
        'Freighter not installed. Please install the extension.'
      )
    );
    expect(window.open).toHaveBeenCalledWith('https://www.freighter.app/', '_blank');
    expect(screen.getByTestId('address').textContent).toBe('none');
  });

  it('surfaces a rejection error when the user declines the allow prompt', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: false });

    renderWallet();
    await connectViaFreighter();

    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('Connection rejected by user.')
    );
  });

  it('treats an unrecognized setAllowed() return shape as rejected', async () => {
    // Neither a boolean nor an object with an `isAllowed` key - exercises
    // extractAllowedState()'s final `return false` fallback.
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ unexpected: true } as any);

    renderWallet();
    await connectViaFreighter();

    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('Connection rejected by user.')
    );
  });

  it('surfaces an error returned by getAddress()', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: null, error: 'user locked wallet' } as any);

    renderWallet();
    await connectViaFreighter();

    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('user locked wallet'));
    expect(screen.getByTestId('address').textContent).toBe('none');
  });

  it('surfaces a network-mismatch error after connecting on the wrong network', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'PUBLIC' } as any);

    renderWallet();
    await connectViaFreighter();

    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('Please switch Freighter to TESTNET')
    );
    expect(screen.getByTestId('networkMismatch').textContent).toBe('true');
    expect(screen.getByTestId('rpcMismatch').textContent).toBe('true');
    expect(screen.getByTestId('walletNetwork').textContent).toBe('mainnet');
    // Successful-connection tracking must not fire on a mismatched network.
    expect(mockedTrackEvent).not.toHaveBeenCalledWith('wallet_connected', expect.anything());
  });

  it('treats a non-string `network` field as unknown (null walletNetwork)', async () => {
    // Exercises extractNetworkName()'s `typeof network === 'string' ? ... : null`
    // false branch: the object has a `network` key, but it isn't a string.
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 12345 } as any);

    renderWallet();
    await connectViaFreighter();

    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));
    expect(screen.getByTestId('walletNetwork').textContent).toBe('none');
    expect(screen.getByTestId('networkMismatch').textContent).toBe('false');
  });

  it('does nothing when setAllowed succeeds but getAddress returns neither an address nor an error', async () => {
    // Exercises connectFreighter()'s `if (address)` false branch.
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: null } as any);

    renderWallet();
    await connectViaFreighter();

    // Give the (no-op) resolution a tick, then assert nothing changed.
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId('address').textContent).toBe('none');
    expect(screen.getByTestId('error').textContent).toBe('none');
  });

  it('clears walletNetwork/mismatch state when the extension reports no network', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({} as any);

    renderWallet();
    await connectViaFreighter();

    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));
    expect(screen.getByTestId('walletNetwork').textContent).toBe('none');
    expect(screen.getByTestId('networkMismatch').textContent).toBe('false');
  });

  it('surfaces a thrown error message from the connect flow', async () => {
    mockedIsConnected.mockRejectedValue(new Error('device disconnected'));

    renderWallet();
    await connectViaFreighter();

    await waitFor(() =>
      expect(screen.getByTestId('error').textContent).toBe('device disconnected')
    );
  });

  it('falls back to a generic error message when the thrown error has none', async () => {
    mockedIsConnected.mockRejectedValue({});

    renderWallet();
    await connectViaFreighter();

    await waitFor(() => expect(screen.getByTestId('error').textContent).toBe('Connection failed'));
  });

  it('records the walletconnect choice via the modal without calling freighter', async () => {
    renderWallet();
    fireEvent.click(screen.getByRole('button', { name: 'connect' }));
    const wcButton = await screen.findByRole('button', { name: 'select-walletconnect' });
    fireEvent.click(wcButton);

    expect(localStorage.getItem(WALLET_PROVIDER_STORAGE_KEY)).toBe('walletconnect');
    await waitFor(() =>
      expect(screen.getByTestId('preferredProvider').textContent).toBe('walletconnect')
    );
    // connectFreighter() itself never ran - no freighter address/allow calls.
    expect(mockedSetAllowed).not.toHaveBeenCalled();
    expect(screen.getByTestId('address').textContent).toBe('none');
  });
});

// ─── disconnect() ───────────────────────────────────────────────────────────

describe('disconnect()', () => {
  it('clears in-memory state, storage, tracks the event, and redirects home', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);
    mockedGetWalletRoles.mockResolvedValue(['freelancer']);

    renderWallet();
    await connectViaFreighter();
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));
    await waitFor(() => expect(screen.getByTestId('roles').textContent).toBe('freelancer'));

    fireEvent.click(screen.getByRole('button', { name: 'disconnect' }));

    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe('none'));
    expect(screen.getByTestId('preferredProvider').textContent).toBe('none');
    expect(screen.getByTestId('networkMismatch').textContent).toBe('false');
    expect(screen.getByTestId('rpcMismatch').textContent).toBe('false');
    expect(screen.getByTestId('roles').textContent).toBe('none');
    expect(screen.getByTestId('rolesLoading').textContent).toBe('false');
    expect(localStorage.getItem(WALLET_ADDRESS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(WALLET_PROVIDER_STORAGE_KEY)).toBeNull();
    expect(mockedTrackEvent).toHaveBeenCalledWith('wallet_disconnected');
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'success', title: 'Disconnected' })
    );
    expect(pushMock).toHaveBeenCalledWith('/');
  });
});

// ─── signTx() ───────────────────────────────────────────────────────────────

describe('signTx()', () => {
  it('returns the signed XDR on success', async () => {
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);
    mockedSignTransaction.mockResolvedValue({ signedTxXdr: 'signed-abc' } as any);

    renderWallet();
    fireEvent.click(screen.getByRole('button', { name: 'signTx' }));

    await waitFor(() => expect(screen.getByTestId('signResult').textContent).toBe('signed-abc'));
  });

  it('accepts a bare string return shape from signTransaction()', async () => {
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);
    mockedSignTransaction.mockResolvedValue('signed-string' as any);

    renderWallet();
    fireEvent.click(screen.getByRole('button', { name: 'signTx' }));

    await waitFor(() => expect(screen.getByTestId('signResult').textContent).toBe('signed-string'));
  });

  it('throws a network-mismatch error before attempting to sign', async () => {
    mockedGetNetwork.mockResolvedValue({ network: 'PUBLIC' } as any);

    renderWallet();
    fireEvent.click(screen.getByRole('button', { name: 'signTx' }));

    await waitFor(() =>
      expect(screen.getByTestId('signResult').textContent).toBe(
        'ERROR:Network mismatch. Please switch to TESTNET'
      )
    );
    expect(mockedSignTransaction).not.toHaveBeenCalled();
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', title: 'Transaction Failed' })
    );
  });

  it('throws a network-mismatch error when checkNetwork itself fails', async () => {
    mockedGetNetwork.mockRejectedValue(new Error('rpc down'));

    renderWallet();
    fireEvent.click(screen.getByRole('button', { name: 'signTx' }));

    await waitFor(() =>
      expect(screen.getByTestId('signResult').textContent).toBe(
        'ERROR:Network mismatch. Please switch to TESTNET'
      )
    );
  });

  it('throws when freighter returns a structured error', async () => {
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);
    mockedSignTransaction.mockResolvedValue({ error: 'user rejected' } as any);

    renderWallet();
    fireEvent.click(screen.getByRole('button', { name: 'signTx' }));

    await waitFor(() =>
      expect(screen.getByTestId('signResult').textContent).toBe('ERROR:user rejected')
    );
  });

  it('throws a generic error when freighter returns neither a string nor signedTxXdr', async () => {
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);
    mockedSignTransaction.mockResolvedValue({} as any);

    renderWallet();
    fireEvent.click(screen.getByRole('button', { name: 'signTx' }));

    await waitFor(() =>
      expect(screen.getByTestId('signResult').textContent).toBe(
        'ERROR:Freighter did not return a signed transaction.'
      )
    );
  });
});

describe('authenticate()', () => {
  it('authenticates the currently connected Freighter identity', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);
    renderWallet();
    await connectViaFreighter();
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));

    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

    await waitFor(() => expect(screen.getByTestId('authStatus').textContent).toBe('authenticated'));
    expect(mockedAuthenticateWithSep10).toHaveBeenCalledWith(
      expect.objectContaining({ address: ADDRESS, network: 'TESTNET' })
    );
  });

  it('clears the SEP-10 session when the wallet disconnects', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);
    renderWallet();
    await connectViaFreighter();
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));
    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));
    await waitFor(() => expect(screen.getByTestId('authStatus').textContent).toBe('authenticated'));

    fireEvent.click(screen.getByRole('button', { name: 'disconnect' }));

    expect(screen.getByTestId('authStatus').textContent).toBe('idle');
    expect(screen.getByTestId('authError').textContent).toBe('none');
  });

  it.each([
    [401, 'HTTP_UNAUTHORIZED', 'expired'],
    [403, 'HTTP_FORBIDDEN', 'authenticated'],
  ] as const)(
    'keeps backend HTTP %i distinct and recoverable',
    async (status, code, expectedStatus) => {
      mockedIsConnected.mockResolvedValue({ isConnected: true });
      mockedSetAllowed.mockResolvedValue({ isAllowed: true });
      mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
      mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);
      sep10Mocks.authenticatedFetch.mockRejectedValue(
        new Sep10Error(
          code,
          status === 401 ? 'Backend authentication expired.' : 'Backend access is forbidden.'
        )
      );
      renderWallet();
      await connectViaFreighter();
      await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));
      fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));
      await waitFor(() =>
        expect(screen.getByTestId('authStatus').textContent).toBe('authenticated')
      );

      fireEvent.click(screen.getByRole('button', { name: 'authenticatedRequest' }));

      await waitFor(() =>
        expect(screen.getByTestId('requestResult').textContent).toBe(
          status === 401 ? 'Backend authentication expired.' : 'Backend access is forbidden.'
        )
      );
      expect(screen.getByTestId('authStatus').textContent).toBe(expectedStatus);
      expect(screen.getByTestId('authError').textContent).toBe(
        status === 401 ? 'Backend authentication expired.' : 'Backend access is forbidden.'
      );
    }
  );

  it('expires the in-memory SEP-10 session when its token expires', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);
    mockedAuthenticateWithSep10.mockImplementation(async (options) => {
      await options.assertWalletIdentity();
      return {
        token: 'valid.jwt.token',
        address: options.address,
        domain: 'example.com',
        authOrigin: 'https://auth.example.com',
        network: options.network,
        expiresAt: Date.now() + 50,
      };
    });
    renderWallet();
    await connectViaFreighter();
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));
    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));
    await waitFor(() => expect(screen.getByTestId('authStatus').textContent).toBe('authenticated'));

    await waitFor(() => expect(screen.getByTestId('authStatus').textContent).toBe('expired'), {
      timeout: 1_000,
    });
    expect(screen.getByTestId('authError').textContent).toMatch(/session expired/i);
  });

  it('rejects authentication if the active wallet account changes', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);
    renderWallet();
    await connectViaFreighter();
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));
    mockedGetAddress.mockResolvedValue({
      address: 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
    } as any);

    fireEvent.click(screen.getByRole('button', { name: 'authenticate' }));

    await waitFor(() => expect(screen.getByTestId('authStatus').textContent).toBe('error'));
    expect(screen.getByTestId('authError').textContent).toMatch(/account changed/i);
  });
});

// ─── switchNetwork() ────────────────────────────────────────────────────────

describe('switchNetwork()', () => {
  it('does nothing when no wallet is connected', async () => {
    renderWallet();
    fireEvent.click(screen.getByRole('button', { name: 'switchNetwork' }));

    // Give any accidental async work a tick to run, then assert no toast fired.
    await act(async () => {
      await Promise.resolve();
    });
    expect(addToastMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('switchingNetwork').textContent).toBe('false');
  });

  it('switches via a window.stellar.freighter extension and reports success', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);

    const setNetwork = vi.fn().mockResolvedValue(undefined);
    (window as any).stellar = { freighter: { setNetwork } };

    renderWallet();
    await connectViaFreighter();
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));

    fireEvent.click(screen.getByRole('button', { name: 'switchNetwork' }));

    await waitFor(() =>
      expect(addToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'success', title: 'Network Switched' })
      )
    );
    expect(setNetwork).toHaveBeenCalledWith('TESTNET');
    await waitFor(() => expect(screen.getByTestId('switchingNetwork').textContent).toBe('false'));
  });

  it('switches via a window.freighter extension fallback', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);

    const setNetwork = vi.fn().mockResolvedValue(undefined);
    (window as any).freighter = { setNetwork };

    renderWallet();
    await connectViaFreighter();
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));

    fireEvent.click(screen.getByRole('button', { name: 'switchNetwork' }));

    await waitFor(() => expect(setNetwork).toHaveBeenCalledWith('TESTNET'));
  });

  it('does not show a success toast if the network was already mismatched', async () => {
    // switchNetwork() reads `networkMismatch` from its own closure (captured
    // at the point the callback was last recreated), not the fresh value
    // `checkNetwork()` computes inside the same call. So to observe the
    // "still mismatched -> no success toast" branch, the mismatch must exist
    // *before* switchNetwork() runs (recreating the callback with
    // networkMismatch=true), not just returned by the extension afterwards.
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'PUBLIC' } as any);

    const setNetwork = vi.fn().mockResolvedValue(undefined);
    (window as any).stellar = { freighter: { setNetwork } };

    renderWallet();
    await connectViaFreighter();
    await waitFor(() => expect(screen.getByTestId('networkMismatch').textContent).toBe('true'));

    addToastMock.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'switchNetwork' }));

    await waitFor(() => expect(setNetwork).toHaveBeenCalledWith('TESTNET'));
    await waitFor(() => expect(screen.getByTestId('switchingNetwork').textContent).toBe('false'));
    expect(addToastMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Network Switched' })
    );
  });

  it('falls back to requestAccess() with an info toast when no extension hook exists', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);

    renderWallet();
    await connectViaFreighter();
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));

    fireEvent.click(screen.getByRole('button', { name: 'switchNetwork' }));

    await waitFor(() => expect(mockedRequestAccess).toHaveBeenCalled());
    expect(addToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'info', title: 'Switch Network' })
    );
  });

  it('shows an error toast when switching throws', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);

    const setNetwork = vi.fn().mockRejectedValue(new Error('extension busy'));
    (window as any).stellar = { freighter: { setNetwork } };

    renderWallet();
    await connectViaFreighter();
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));

    fireEvent.click(screen.getByRole('button', { name: 'switchNetwork' }));

    await waitFor(() =>
      expect(addToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'error', title: 'Switch Failed' })
      )
    );
    expect(screen.getByTestId('switchingNetwork').textContent).toBe('false');
  });
});

// ─── Role detection ─────────────────────────────────────────────────────────

describe('role detection', () => {
  it('fetches and stores roles once an address is connected', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);
    mockedGetWalletRoles.mockResolvedValue(['freelancer', 'lp']);

    renderWallet();
    await connectViaFreighter();

    await waitFor(() => expect(screen.getByTestId('roles').textContent).toBe('freelancer,lp'));
    expect(mockedGetWalletRoles).toHaveBeenCalledWith(ADDRESS);
    expect(screen.getByTestId('rolesLoading').textContent).toBe('false');
  });

  it('clears roles without calling getWalletRoles when the network is mismatched', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'PUBLIC' } as any);

    renderWallet();
    await connectViaFreighter();

    await waitFor(() => expect(screen.getByTestId('networkMismatch').textContent).toBe('true'));
    expect(screen.getByTestId('roles').textContent).toBe('none');
    expect(screen.getByTestId('rolesLoading').textContent).toBe('false');
    expect(mockedGetWalletRoles).not.toHaveBeenCalled();
  });

  it('clears roles on a failed lookup', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);
    mockedGetWalletRoles.mockRejectedValue(new Error('rpc timeout'));

    renderWallet();
    await connectViaFreighter();

    await waitFor(() => expect(screen.getByTestId('rolesLoading').textContent).toBe('false'));
    expect(screen.getByTestId('roles').textContent).toBe('none');
  });

  it('does not update state after unmounting mid-fetch (cancelled guard)', async () => {
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);

    let resolveRoles: (roles: string[]) => void = () => {};
    mockedGetWalletRoles.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRoles = resolve;
        })
    );

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = renderWallet();
    await connectViaFreighter();
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));
    await waitFor(() => expect(screen.getByTestId('rolesLoading').textContent).toBe('true'));

    unmount();

    // Resolving after unmount must not trigger a React "state update on an
    // unmounted component" / "not wrapped in act" warning - proof the
    // `cancelled` guard suppressed the post-unmount setRoles/setRolesLoading.
    await act(async () => {
      resolveRoles(['payer']);
      await Promise.resolve();
    });

    const offendingCalls = consoleErrorSpy.mock.calls.filter((args) =>
      String(args[0]).match(/not wrapped in act|unmounted component/i)
    );
    expect(offendingCalls).toHaveLength(0);
  });

  it('does not update state after unmounting mid-fetch when the fetch rejects', async () => {
    // Same cancelled-guard, but through the catch branch (getWalletRoles
    // rejects instead of resolving) - covers `if (!cancelled) setRoles([])`
    // inside the catch block specifically.
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);

    let rejectRoles: (err: Error) => void = () => {};
    mockedGetWalletRoles.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectRoles = reject;
        })
    );

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { unmount } = renderWallet();
    await connectViaFreighter();
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe(ADDRESS));
    await waitFor(() => expect(screen.getByTestId('rolesLoading').textContent).toBe('true'));

    unmount();

    await act(async () => {
      rejectRoles(new Error('rpc timeout'));
      await Promise.resolve();
      await Promise.resolve();
    });

    const offendingCalls = consoleErrorSpy.mock.calls.filter((args) =>
      String(args[0]).match(/not wrapped in act|unmounted component/i)
    );
    expect(offendingCalls).toHaveLength(0);
  });
});

// ─── Periodic network re-check ──────────────────────────────────────────────

describe('periodic network polling', () => {
  it('re-checks the network every 5s while an address is connected', async () => {
    // Fake timers must be active *before* the address-connected effect
    // registers its `setInterval`, otherwise that interval is a real timer
    // that `vi.advanceTimersByTime` can never fast-forward. That also rules
    // out RTL's `waitFor`/`findByRole` here (they poll via real
    // `setTimeout`), so every step below flushes microtasks manually via
    // `vi.advanceTimersByTimeAsync(0)` instead.
    mockedIsConnected.mockResolvedValue({ isConnected: true });
    mockedSetAllowed.mockResolvedValue({ isAllowed: true });
    mockedGetAddress.mockResolvedValue({ address: ADDRESS } as any);
    mockedGetNetwork.mockResolvedValue({ network: 'TESTNET' } as any);

    vi.useFakeTimers();
    try {
      renderWallet();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      fireEvent.click(screen.getByRole('button', { name: 'connect' }));
      const modalButton = screen.getByRole('button', { name: 'select-freighter' });
      await act(async () => {
        fireEvent.click(modalButton);
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByTestId('address').textContent).toBe(ADDRESS);
      const callsBeforeTick = mockedGetNetwork.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });

      expect(mockedGetNetwork.mock.calls.length).toBeGreaterThan(callsBeforeTick);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call getNetwork from the interval while disconnected', async () => {
    vi.useFakeTimers();
    try {
      renderWallet();
      await act(async () => {
        for (let i = 0; i < 5; i += 1) {
          await Promise.resolve();
        }
      });

      const callsBeforeTick = mockedGetNetwork.mock.calls.length;

      await act(async () => {
        vi.advanceTimersByTime(5000);
        for (let i = 0; i < 5; i += 1) {
          await Promise.resolve();
        }
      });

      // No address connected, so the interval's `if (address)` guard skips
      // calling checkNetwork -> getNetwork call count is unchanged.
      expect(mockedGetNetwork.mock.calls.length).toBe(callsBeforeTick);
    } finally {
      vi.useRealTimers();
    }
  });
});
