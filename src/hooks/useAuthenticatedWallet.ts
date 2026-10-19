'use client';

import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { signTransaction } from '@stellar/freighter-api';
import { NETWORK_PASSPHRASE } from '@/constants';
import { WalletContext, type WalletContextType } from '@/context/WalletContext';
import {
  AuthenticationError,
  getAuthResponseCode,
  getWalletErrorCode,
  type AuthErrorCode,
} from '@/lib/auth/errors';

interface AuthSession {
  token: string;
  account: string;
  network: string;
  expiresAt: number;
}

export type AuthStatus = 'idle' | 'authenticating' | 'authenticated' | 'error';

async function readAuthResponse(response: Response, fallback: AuthErrorCode): Promise<unknown> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new AuthenticationError(fallback, 'Authentication service returned an invalid response');
  }

  if (!response.ok) {
    const code = getAuthResponseCode(payload, fallback);
    const message =
      payload &&
      typeof payload === 'object' &&
      'error' in payload &&
      typeof payload.error === 'string'
        ? payload.error
        : 'Authentication request failed';
    throw new AuthenticationError(code, message);
  }
  return payload;
}

async function performSEP10Auth(
  publicKey: string
): Promise<Omit<AuthSession, 'account' | 'network'>> {
  let challengeResponse: Response;
  try {
    challengeResponse = await fetch(`/api/auth/challenge?account=${encodeURIComponent(publicKey)}`);
  } catch {
    throw new AuthenticationError('exchange_failed', 'Could not request authentication challenge');
  }
  const challengePayload = await readAuthResponse(challengeResponse, 'challenge_invalid');
  const challenge =
    challengePayload && typeof challengePayload === 'object' && 'challenge' in challengePayload
      ? challengePayload.challenge
      : undefined;
  if (typeof challenge !== 'string' || challenge.length === 0) {
    throw new AuthenticationError('challenge_invalid', 'Authentication challenge is missing');
  }

  let signedChallenge: unknown;
  try {
    signedChallenge = await signTransaction(challenge, {
      networkPassphrase: NETWORK_PASSPHRASE,
    });
  } catch (error) {
    throw new AuthenticationError(getWalletErrorCode(error), 'Wallet did not sign the challenge');
  }
  if (signedChallenge && typeof signedChallenge === 'object' && 'error' in signedChallenge) {
    throw new AuthenticationError(
      getWalletErrorCode(signedChallenge.error),
      'Wallet did not sign the challenge'
    );
  }
  const signedXdr =
    typeof signedChallenge === 'string'
      ? signedChallenge
      : signedChallenge &&
          typeof signedChallenge === 'object' &&
          'signedTxXdr' in signedChallenge &&
          typeof signedChallenge.signedTxXdr === 'string'
        ? signedChallenge.signedTxXdr
        : '';
  if (!signedXdr) {
    throw new AuthenticationError('wallet_rejected', 'Wallet did not sign the challenge');
  }

  let verifyResponse: Response;
  try {
    verifyResponse = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: publicKey, transaction: signedXdr }),
    });
  } catch {
    throw new AuthenticationError('exchange_failed', 'Could not exchange authentication challenge');
  }
  const verifyPayload = await readAuthResponse(verifyResponse, 'exchange_failed');
  const token =
    verifyPayload && typeof verifyPayload === 'object' && 'token' in verifyPayload
      ? verifyPayload.token
      : undefined;
  const expiresAt =
    verifyPayload && typeof verifyPayload === 'object' && 'expiresAt' in verifyPayload
      ? verifyPayload.expiresAt
      : undefined;

  if (typeof token !== 'string' || token.length === 0 || typeof expiresAt !== 'string') {
    throw new AuthenticationError('exchange_failed', 'Authentication response is incomplete');
  }

  const expiryTime = Date.parse(expiresAt);
  if (!Number.isFinite(expiryTime) || expiryTime <= Date.now()) {
    throw new AuthenticationError('session_expired', 'Authentication session has expired');
  }
  return { token, expiresAt: expiryTime };
}

export interface UseAuthenticatedWalletReturn {
  isConnected: boolean;
  publicKey: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (txXdr: string) => Promise<string>;
  jwt: string | null;
  authStatus: AuthStatus;
  authError: AuthErrorCode | null;
  retryAuthentication: () => void;
}

export function useAuthenticatedWallet(): UseAuthenticatedWalletReturn {
  const context = useWalletContext();
  const { address, isConnected, networkMismatch, walletNetwork } = context;
  const {
    connect: connectWallet,
    disconnect: disconnectWallet,
    signTx: signWalletTransaction,
  } = context;
  const [session, setSession] = useState<AuthSession | null>(null);
  const [authStatus, setAuthStatus] = useState<AuthStatus>('idle');
  const [authError, setAuthError] = useState<AuthErrorCode | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const sessionRef = useRef<AuthSession | null>(null);
  const attemptedIdentityRef = useRef<string | null>(null);

  const replaceSession = useCallback((nextSession: AuthSession | null) => {
    sessionRef.current = nextSession;
    setSession(nextSession);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const identity = address && walletNetwork ? `${address}:${walletNetwork}` : null;
    const currentSession = sessionRef.current;

    if (
      currentSession &&
      (currentSession.account !== address || currentSession.network !== walletNetwork)
    ) {
      replaceSession(null);
      attemptedIdentityRef.current = null;
      setAuthError(
        currentSession.account !== address ? 'wallet_identity_changed' : 'network_changed'
      );
      setAuthStatus('error');
    }

    if (!isConnected || !address) {
      if (currentSession) replaceSession(null);
      attemptedIdentityRef.current = null;
      setAuthStatus('idle');
      if (!address) setAuthError(null);
      return () => {
        cancelled = true;
      };
    }

    if (networkMismatch) {
      replaceSession(null);
      attemptedIdentityRef.current = null;
      setAuthError('network_changed');
      setAuthStatus('error');
      return () => {
        cancelled = true;
      };
    }

    if (!walletNetwork || !identity) {
      return () => {
        cancelled = true;
      };
    }

    const validSession = sessionRef.current;
    if (validSession?.account === address && validSession.network === walletNetwork) {
      if (validSession.expiresAt <= Date.now()) {
        replaceSession(null);
        setAuthError('session_expired');
        setAuthStatus('error');
      } else {
        setAuthError(null);
        setAuthStatus('authenticated');
      }
      return () => {
        cancelled = true;
      };
    }

    if (attemptedIdentityRef.current === identity) {
      return () => {
        cancelled = true;
      };
    }

    attemptedIdentityRef.current = identity;
    setAuthError(null);
    setAuthStatus('authenticating');

    void performSEP10Auth(address)
      .then((result) => {
        if (cancelled) return;
        replaceSession({
          ...result,
          account: address,
          network: walletNetwork,
        });
        setAuthError(null);
        setAuthStatus('authenticated');
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        attemptedIdentityRef.current = null;
        const code = error instanceof AuthenticationError ? error.code : getWalletErrorCode(error);
        setAuthError(code);
        setAuthStatus('error');
      });

    return () => {
      cancelled = true;
    };
  }, [address, isConnected, networkMismatch, walletNetwork, retryCount, replaceSession]);

  useEffect(() => {
    if (!session) return;
    const remaining = session.expiresAt - Date.now();
    const timeout = window.setTimeout(
      () => {
        if (sessionRef.current === session) {
          replaceSession(null);
          attemptedIdentityRef.current = null;
          setAuthError('session_expired');
          setAuthStatus('error');
        }
      },
      Math.max(0, remaining)
    );
    return () => window.clearTimeout(timeout);
  }, [session, replaceSession]);

  const connect = useCallback(async () => {
    if (isConnected && authStatus === 'error') {
      setRetryCount((current) => current + 1);
      return;
    }
    await connectWallet();
  }, [authStatus, connectWallet, isConnected]);

  const retryAuthentication = useCallback(() => {
    attemptedIdentityRef.current = null;
    setRetryCount((current) => current + 1);
  }, []);

  const disconnect = useCallback(() => {
    attemptedIdentityRef.current = null;
    replaceSession(null);
    setAuthError(null);
    setAuthStatus('idle');
    disconnectWallet();
  }, [disconnectWallet, replaceSession]);

  const signTx = useCallback(
    async (txXdr: string): Promise<string> => {
      if (!isConnected) {
        throw new AuthenticationError('wallet_not_connected', 'Wallet is not connected');
      }
      return signWalletTransaction(txXdr);
    },
    [isConnected, signWalletTransaction]
  );

  const sessionMatchesWallet =
    session !== null && session.account === address && session.network === walletNetwork;
  const effectiveAuthError = authError ?? (isConnected ? null : context.errorCode);

  return {
    isConnected,
    publicKey: address,
    connect,
    disconnect,
    signTransaction: signTx,
    jwt: sessionMatchesWallet ? session.token : null,
    authStatus: effectiveAuthError ? 'error' : authStatus,
    authError: effectiveAuthError,
    retryAuthentication,
  };
}

function useWalletContext(): WalletContextType {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useAuthenticatedWallet must be used within a WalletProvider');
  }
  return context;
}
