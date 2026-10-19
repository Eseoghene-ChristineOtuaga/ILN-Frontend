/**
 * Wallet session storage cleanup (#4).
 *
 * On disconnect we must drop every trace of the previous session: the stored
 * address plus any wallet-scoped caches (address book, watchlist, referral
 * attribution, cached invoice/portfolio data). Centralised here so disconnect
 * has a single, testable definition of "what counts as session data".
 */

export const WALLET_ADDRESS_STORAGE_KEY = 'iln_wallet_address';
export const WALLET_PROVIDER_STORAGE_KEY = 'iln_wallet_provider';
/** Dispatched to other tabs when this tab's wallet session is cleared so they
 *  drop retained session data too (cross-tab disconnect privacy, issue #1098). */
export const WALLET_DISCONNECT_STORAGE_KEY = 'iln_wallet_disconnect';

export type WalletProviderType = 'freighter' | 'walletconnect';

export function getStoredWalletProvider(
  storage: Storage = window.localStorage
): WalletProviderType | null {
  const value = storage.getItem(WALLET_PROVIDER_STORAGE_KEY);
  return value === 'freighter' || value === 'walletconnect' ? value : null;
}

export function setStoredWalletProvider(
  provider: WalletProviderType,
  storage: Storage = window.localStorage
): void {
  storage.setItem(WALLET_PROVIDER_STORAGE_KEY, provider);
}

/**
 * Prefixes/keys considered user-session data, removed on disconnect.
 * `iln-address-book-` covers both the legacy `<prefix><wallet>` key and the
 * origin/network-scoped `<prefix>v1-<tag>-<wallet>` key (walletRecordStore.ts).
 */
export const WALLET_SCOPED_PREFIXES = [
  'iln-address-book-',
  'iln-watchlist',
  'iln-referral-',
  'iln-invoices-',
  'iln-portfolio-',
  'freelancerInvoices',
];

export function clearWalletStorage(storage: Storage = window.localStorage): void {
  storage.removeItem(WALLET_ADDRESS_STORAGE_KEY);
  storage.removeItem(WALLET_PROVIDER_STORAGE_KEY);
  const toRemove: string[] = [];
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    if (key && WALLET_SCOPED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
      toRemove.push(key);
    }
  }
  toRemove.forEach((key) => storage.removeItem(key));
  // Notify other tabs so they clear retained session data as well.
  broadcastWalletDisconnect(storage);
}

/** Signal every other tab that this tab's wallet session was cleared. */
export function broadcastWalletDisconnect(storage: Storage = window.localStorage): void {
  try {
    storage.setItem(WALLET_DISCONNECT_STORAGE_KEY, String(Date.now()));
    storage.removeItem(WALLET_DISCONNECT_STORAGE_KEY);
  } catch {
    // best-effort cross-tab signal
  }
}
