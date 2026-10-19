'use client';

import { useMemo, useState, useRef, useEffect } from 'react';
import { useApprovedTokens } from '@/hooks/useApprovedTokens';
import { useBalances } from '@/hooks/useBalances';
import { useWallet } from '@/context/WalletContext';
import { TokenAmount } from './TokenSelector';
import { WalletPrivacyControls } from './WalletPrivacyControls';
import { formatAddress, formatTokenAmount } from '@/utils/format';
import { NETWORK_NAME } from '@/constants';
import TestnetFaucetButton from './TestnetFaucetButton';

export default function WalletButton() {
  const {
    address,
    isConnected,
    isInstalled,
    isReconnecting,
    preferredWalletProvider,
    connect,
    disconnect,
    networkMismatch,
    error,
    authStatus,
    authError,
    authDiagnostics,
    authenticate,
  } = useWallet();
  const { tokens } = useApprovedTokens();
  const allowedTokens = useMemo(() => tokens.filter((token) => token.isAllowed), [tokens]);
  // Auto-refreshes every 30s and on each successful transaction; tokens that
  // fail to load surface via `unavailable` for the "Add Trustline" prompt.
  const { balances, unavailable, isLoading: isLoadingBalances } = useBalances(tokens);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleCopyAddress = async () => {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard unavailable — nothing actionable to surface.
    }
  };

  const handleAuthenticate = () => {
    void authenticate().catch((cause: unknown) => {
      if (!(cause instanceof Error)) {
        console.error('SEP-10 authentication failed', cause);
      }
    });
  };

  if (isConnected) {
    return (
      <div className="relative" ref={dropdownRef}>
        <button
          onClick={() => setDropdownOpen(!dropdownOpen)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-full border border-outline-variant/15 transition-all focus:outline-none focus:ring-2 focus:ring-primary/50
            ${
              dropdownOpen
                ? 'bg-surface-container'
                : 'bg-surface-container-low hover:bg-surface-container'
            }
          `}
          title={address!}
          aria-expanded={dropdownOpen}
        >
          <span
            className={`w-2 h-2 rounded-full ${
              networkMismatch ? 'bg-error animate-pulse' : 'bg-green-500'
            }`}
            aria-label={networkMismatch ? 'Wrong network' : 'Connected'}
          />
          <span
            className={`text-[10px] font-bold uppercase ${
              networkMismatch ? 'text-error' : 'text-primary'
            }`}
          >
            {networkMismatch ? 'Wrong Network' : NETWORK_NAME}
          </span>
          <span className="text-on-surface-variant/30">|</span>
          <span
            className={`text-sm font-mono font-medium ${
              networkMismatch ? 'text-error' : 'text-on-surface'
            }`}
          >
            {formatAddress(address!)}
          </span>
          <span
            className="material-symbols-outlined text-[16px] text-on-surface-variant transition-transform duration-200"
            style={{ transform: dropdownOpen ? 'rotate(180deg)' : 'none' }}
          >
            expand_more
          </span>
        </button>

        {dropdownOpen && (
          <div className="absolute right-0 mt-2 min-w-[240px] rounded-xl border border-outline-variant/20 bg-surface-container-high shadow-xl z-[60] animate-in fade-in zoom-in-95 duration-150 overflow-hidden">
            {!networkMismatch && (
              <div className="flex flex-col gap-1.5 p-3">
                <p className="px-1 text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface-variant/70">
                  Balances
                </p>
                {isLoadingBalances && balances.size === 0 && unavailable.size === 0 ? (
                  <p className="px-1 text-xs text-on-surface-variant">Loading balances...</p>
                ) : (
                  allowedTokens.map((token) => {
                    const amount = balances.get(token.contractId);
                    const isUnavailable = unavailable.has(token.contractId);
                    // Not yet loaded and not flagged unavailable — skip until it resolves.
                    if (amount === undefined && !isUnavailable) return null;

                    return (
                      <div
                        key={token.contractId}
                        className="flex items-center justify-between gap-2 rounded-lg px-1 py-1 text-sm font-bold text-on-surface"
                      >
                        <TokenAmount
                          amount={formatTokenAmount(amount ?? 0n, token)}
                          token={token}
                        />
                        {isUnavailable ? (
                          <button
                            type="button"
                            onClick={connect}
                            title={`No ${token.symbol} trustline found for this wallet. Add one to hold ${token.symbol}.`}
                            className="rounded-full bg-primary-container px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-on-primary-container hover:bg-primary-container/80 transition-colors"
                          >
                            Add Trustline
                          </button>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </div>
            )}

            <section
              aria-label="Authentication readiness"
              className="flex flex-col gap-2 border-t border-outline-variant/10 p-3"
            >
              <p className="px-1 text-[10px] font-bold uppercase tracking-[0.16em] text-on-surface-variant/70">
                SEP-10 authentication
              </p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-1 text-xs text-on-surface-variant">
                <dt>Domain</dt>
                <dd className="truncate text-right text-on-surface">
                  {authDiagnostics.domain ?? 'Not discovered'}
                </dd>
                <dt>Network</dt>
                <dd className="text-right text-on-surface">{authDiagnostics.network}</dd>
                <dt>Session expiry</dt>
                <dd className="text-right text-on-surface">
                  {authDiagnostics.expiresAt
                    ? new Intl.DateTimeFormat(undefined, {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      }).format(authDiagnostics.expiresAt)
                    : 'No active session'}
                </dd>
                <dt>Auth server</dt>
                <dd className="text-right text-on-surface">
                  {authDiagnostics.serverHealth === 'available'
                    ? 'Available'
                    : authDiagnostics.serverHealth === 'unavailable'
                      ? 'Unavailable'
                      : 'Not checked'}
                </dd>
              </dl>
              <button
                type="button"
                onClick={handleAuthenticate}
                disabled={networkMismatch || authStatus === 'authenticating'}
                className="min-h-10 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-surface-container-lowest transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {authStatus === 'authenticating'
                  ? 'Authenticating...'
                  : authStatus === 'authenticated'
                    ? 'Refresh authentication'
                    : 'Authenticate wallet'}
              </button>
              {authError && (
                <p className="px-1 text-xs text-error" role="alert">
                  {authError.message}
                </p>
              )}
              <p className="sr-only" aria-live="polite">
                Authentication status: {authStatus}
              </p>
            </section>

            <div className="flex flex-col gap-1 border-t border-outline-variant/10 p-2">
              <TestnetFaucetButton />
              <WalletPrivacyControls
                address={address!}
                onDisconnect={() => {
                  disconnect();
                  setDropdownOpen(false);
                }}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  const connectionLabel = isReconnecting ? 'Reconnecting...' : 'Connect Wallet';

  return (
    <div className="relative group">
      <button
        onClick={connect}
        disabled={isReconnecting}
        className="flex min-h-11 items-center gap-2 rounded-lg bg-primary px-6 py-2.5 text-sm font-bold text-surface-container-lowest shadow-md transition-all duration-150 hover:bg-primary/90 active:scale-95 disabled:cursor-wait disabled:opacity-70"
      >
        <span className="material-symbols-outlined text-sm">account_balance_wallet</span>
        {connectionLabel}
      </button>
      {isReconnecting && (
        <p className="mt-2 text-xs text-on-surface-variant">
          Attempting to restore your wallet session…
        </p>
      )}
      {!isInstalled && !isReconnecting && preferredWalletProvider !== 'walletconnect' && (
        <a
          href="https://www.freighter.app/"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 flex min-h-[44px] items-center justify-end text-[11px] font-medium text-primary hover:underline"
        >
          Don&apos;t have Freighter? Install it →
        </a>
      )}
      {error && (
        <div className="absolute top-full right-0 mt-2 p-3 bg-error-container text-on-error-container text-xs rounded-lg shadow-xl border border-error/10 w-64 z-[60] animate-in slide-in-from-top-1 duration-200">
          <p className="font-bold flex items-center gap-1">
            <span className="material-symbols-outlined text-sm">error</span>
            Connection Error
          </p>
          <p className="mt-1 opacity-90">{error}</p>
        </div>
      )}
    </div>
  );
}
