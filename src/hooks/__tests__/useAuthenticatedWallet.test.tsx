import type { PropsWithChildren } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as freighterApi from '@stellar/freighter-api';
import { WalletContext, type WalletContextType } from '@/context/WalletContext';
import { useAuthenticatedWallet } from '../useAuthenticatedWallet';

vi.mock('@stellar/freighter-api', () => ({
  signTransaction: vi.fn(),
}));

const validExpiry = () => new Date(Date.now() + 15 * 60 * 1000).toISOString();
const signedXdr = 'signed-challenge-xdr';

function makeWalletContext(overrides: Partial<WalletContextType> = {}): WalletContextType {
  return {
    address: null,
    isConnected: false,
    isInstalled: false,
    isReconnecting: false,
    preferredWalletProvider: null,
    error: null,
    errorCode: null,
    networkMismatch: false,
    rpcMismatch: false,
    mismatchDetails: null,
    switchingNetwork: false,
    walletNetwork: null,
    roles: [],
    rolesLoading: false,
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    signTx: vi.fn().mockResolvedValue('signed-transaction'),
    switchNetwork: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('useAuthenticatedWallet', () => {
  let responseFetch: ReturnType<typeof vi.fn>;
  let wallet: WalletContextType;

  beforeEach(() => {
    vi.clearAllMocks();
    responseFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/auth/challenge')) {
        return Promise.resolve(
          new Response(JSON.stringify({ challenge: 'challenge-xdr' }), { status: 200 })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify({ token: 'session-jwt', expiresAt: validExpiry() }), {
          status: 200,
        })
      );
    });
    vi.stubGlobal('fetch', responseFetch);
    vi.mocked(freighterApi.signTransaction).mockResolvedValue({
      signedTxXdr: signedXdr,
      signerAddress: 'GTEST',
    });
    wallet = makeWalletContext();
  });

  function wrapper({ children }: PropsWithChildren) {
    return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>;
  }

  it('starts disconnected and rejects use outside WalletProvider', () => {
    const { result } = renderHook(() => useAuthenticatedWallet(), { wrapper });
    expect(result.current.isConnected).toBe(false);
    expect(result.current.jwt).toBeNull();
    expect(result.current.authStatus).toBe('idle');
    expect(() => renderHook(() => useAuthenticatedWallet())).toThrow(
      'useAuthenticatedWallet must be used within a WalletProvider'
    );
  });

  it('exposes wallet connection errors using the shared auth code taxonomy', () => {
    wallet = makeWalletContext({
      error: 'Connection rejected by user.',
      errorCode: 'wallet_rejected',
    });
    const { result } = renderHook(() => useAuthenticatedWallet(), { wrapper });

    expect(result.current.authStatus).toBe('error');
    expect(result.current.authError).toBe('wallet_rejected');
  });

  it('authenticates the connected wallet and exposes the token in memory', async () => {
    wallet = makeWalletContext({
      address: 'GCONNECTEDWALLET',
      isConnected: true,
      walletNetwork: 'testnet',
    });
    const { result } = renderHook(() => useAuthenticatedWallet(), { wrapper });

    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'));
    expect(result.current.jwt).toBe('session-jwt');
    expect(responseFetch).toHaveBeenCalledTimes(2);
    expect(responseFetch.mock.calls[0][0]).toContain(
      '/api/auth/challenge?account=GCONNECTEDWALLET'
    );
    expect(JSON.parse(responseFetch.mock.calls[1][1].body)).toEqual({
      account: 'GCONNECTEDWALLET',
      transaction: signedXdr,
    });
    expect(window.localStorage.getItem('jwt')).toBeNull();
  });

  it('invalidates the session and authenticates again when the wallet address changes', async () => {
    wallet = makeWalletContext({
      address: 'GWALLETONE',
      isConnected: true,
      walletNetwork: 'testnet',
    });
    const { result, rerender } = renderHook(() => useAuthenticatedWallet(), { wrapper });
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'));

    wallet = makeWalletContext({
      address: 'GWALLETTWO',
      isConnected: true,
      walletNetwork: 'testnet',
    });
    rerender();
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'));

    expect(result.current.jwt).toBe('session-jwt');
    expect(responseFetch).toHaveBeenCalledTimes(4);
    expect(responseFetch.mock.calls[2][0]).toContain('/api/auth/challenge?account=GWALLETTWO');
  });

  it('invalidates the token on network changes and does not authenticate on a mismatch', async () => {
    wallet = makeWalletContext({
      address: 'GCONNECTEDWALLET',
      isConnected: true,
      walletNetwork: 'testnet',
    });
    const { result, rerender } = renderHook(() => useAuthenticatedWallet(), { wrapper });
    await waitFor(() => expect(result.current.jwt).toBe('session-jwt'));

    wallet = makeWalletContext({
      address: 'GCONNECTEDWALLET',
      isConnected: true,
      networkMismatch: true,
      walletNetwork: 'public',
    });
    rerender();

    await waitFor(() => expect(result.current.authError).toBe('network_changed'));
    expect(result.current.jwt).toBeNull();
    expect(responseFetch).toHaveBeenCalledTimes(2);
  });

  it('maps server rejection and expiry codes to stable UI codes', async () => {
    wallet = makeWalletContext({
      address: 'GCONNECTEDWALLET',
      isConnected: true,
      walletNetwork: 'testnet',
    });
    responseFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 'challenge_expired', error: 'Expired' }), {
        status: 401,
      })
    );
    const { result } = renderHook(() => useAuthenticatedWallet(), { wrapper });

    await waitFor(() => expect(result.current.authError).toBe('challenge_expired'));
    expect(result.current.authStatus).toBe('error');
    expect(result.current.jwt).toBeNull();
  });

  it('maps wallet signature rejection and exposes a retry action', async () => {
    wallet = makeWalletContext({
      address: 'GCONNECTEDWALLET',
      isConnected: true,
      walletNetwork: 'testnet',
    });
    vi.mocked(freighterApi.signTransaction).mockRejectedValueOnce(new Error('User rejected'));
    const { result } = renderHook(() => useAuthenticatedWallet(), { wrapper });

    await waitFor(() => expect(result.current.authError).toBe('wallet_rejected'));
    expect(result.current.authStatus).toBe('error');

    await act(async () => result.current.retryAuthentication());
    await waitFor(() => expect(responseFetch).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(result.current.authStatus).toBe('authenticated'));
  });

  it('expires a server response immediately when its session deadline has passed', async () => {
    wallet = makeWalletContext({
      address: 'GCONNECTEDWALLET',
      isConnected: true,
      walletNetwork: 'testnet',
    });
    responseFetch.mockImplementation((url: string) => {
      if (url.includes('/api/auth/challenge')) {
        return Promise.resolve(
          new Response(JSON.stringify({ challenge: 'challenge-xdr' }), { status: 200 })
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            token: 'expired-token',
            expiresAt: new Date(Date.now() - 1).toISOString(),
          }),
          { status: 200 }
        )
      );
    });
    const { result } = renderHook(() => useAuthenticatedWallet(), { wrapper });

    await waitFor(() => expect(result.current.authError).toBe('session_expired'));
    expect(result.current.jwt).toBeNull();
  });

  it('disconnects and clears the in-memory token', async () => {
    wallet = makeWalletContext({
      address: 'GCONNECTEDWALLET',
      isConnected: true,
      walletNetwork: 'testnet',
    });
    const { result } = renderHook(() => useAuthenticatedWallet(), { wrapper });
    await waitFor(() => expect(result.current.jwt).toBe('session-jwt'));

    act(() => result.current.disconnect());

    expect(result.current.jwt).toBeNull();
    expect(wallet.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects transaction signing while disconnected', async () => {
    const { result } = renderHook(() => useAuthenticatedWallet(), { wrapper });
    await expect(result.current.signTransaction('transaction-xdr')).rejects.toThrow(
      'Wallet is not connected'
    );
  });
});
