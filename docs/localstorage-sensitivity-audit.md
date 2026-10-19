# localStorage Sensitivity Audit

This document enumerates every localStorage key written by the ILN-Frontend codebase,
classifies the data stored in each, and identifies any privacy or security exposure under
a hypothetical XSS scenario (defense-in-depth, complementing the CSP work in Issue #16).

---

## Complete Key Inventory

| #   | Key Pattern                                                                                                             | Source File(s)                                                    | Data Shape                                                                                                         | Sensitivity                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 1   | `iln_wallet_address`                                                                                                    | `src/context/WalletContext.tsx`                                   | `string` — full Stellar public key (e.g. `GABC…`)                                                                  | **Sensitive** — wallet address                                 |
| 2   | `iln_wallet_provider`                                                                                                   | `src/utils/walletStorage.ts`                                      | `"freighter" \| "walletconnect"`                                                                                   | Low — provider name only                                       |
| 3   | `iln-notifications:{walletAddress}`                                                                                     | `src/context/NotificationContext.tsx`                             | `NotificationItem[]` — `{id, category, type, title, message, href, createdAt, read}`                               | Low — app-generated notification text                          |
| 4   | `iln-notification-read:{walletAddress}`                                                                                 | `src/context/NotificationContext.tsx`                             | `Record<string, boolean>` — notification ID → read flag                                                            | Low                                                            |
| 5   | `iln-notification-subscriptions`                                                                                        | `src/screens/settings/NotificationSettings.tsx`                   | `Subscription[]` — `{id, type, target, events, createdAt}`                                                         | **Sensitive** — `target` holds email addresses or webhook URLs |
| 6   | `iln-address-book-v1-{originNetworkTag}-{walletAddress}` (legacy: `iln-address-book-{walletAddress}`, migrated on read) | `src/hooks/useAddressBook.ts`, `src/utils/walletRecordStore.ts`   | Integrity-checked envelope wrapping `AddressBookEntry[]` — `{id, address, nickname}`, expires after 90 days unused | **Sensitive** — wallet addresses + user-chosen nicknames (PII) |
| 7   | `iln-bookmarks`                                                                                                         | `src/hooks/useBookmarks.ts`                                       | `string[]` — bookmarked invoice IDs                                                                                | Low                                                            |
| 8   | `watchlist_{walletAddress}`                                                                                             | `src/hooks/useWatchlist.ts`                                       | `WatchlistItem[]` — `{id, addedAt, lastKnownStatus?}`                                                              | Low — invoice IDs and timestamps only                          |
| 9   | `iln:last-seen-version`                                                                                                 | `src/hooks/useWhatsNew.ts`                                        | `string` — app version label                                                                                       | Low                                                            |
| 10  | `iln_lp_widget_layout_{userId}`                                                                                         | `src/hooks/useLPWidgetLayout.ts`                                  | `Widget[]` — `{id, label, visible, order}`                                                                         | Low — layout preferences only                                  |
| 11  | `iln-lp-settings`                                                                                                       | `src/hooks/useLPSettings.ts`                                      | `{minReputation, notificationPreferences: {categories, inAppEnabled, emailEnabled, email}}`                        | **Sensitive** — contains `email` field                         |
| 12  | `iln-sound-prefs`                                                                                                       | `src/hooks/useSoundNotifications.ts`                              | `{enabled, volume, muted}`                                                                                         | Low                                                            |
| 13  | `iln_recent_commands`                                                                                                   | `src/hooks/useCommandPalette.ts`                                  | `string[]` — command IDs                                                                                           | Low                                                            |
| 14  | `iln_export_columns_{prefix}`                                                                                           | `src/utils/exportColumns.ts`                                      | `string[]` — selected column keys                                                                                  | Low                                                            |
| 15  | `iln_table_config_{tableId}`                                                                                            | `src/components/InvoiceTable.tsx`, `src/components/DataTable.tsx` | `{order: string[], visibility: string[]}`                                                                          | Low                                                            |
| 16  | `iln-referral-{invoiceId}`                                                                                              | `src/components/SubmitInvoiceForm.tsx`                            | `string` — referral code                                                                                           | Low                                                            |
| 17  | `iln_lp_onboarding_completed_{address}`                                                                                 | `src/components/LPDashboard.tsx`                                  | `"true"`                                                                                                           | Low (key contains wallet address)                              |
| 18  | `iln_onboarding_completed_{address}`                                                                                    | `src/components/onboarding/OnboardingFlow.tsx`                    | `"true"`                                                                                                           | Low (key contains wallet address)                              |
| 19  | `iln:dismissed-decay-warning`                                                                                           | `src/components/DecayWarningBanner.tsx`                           | epoch timestamp `string`                                                                                           | Low                                                            |
| 20  | `iln_top_funders_30d`                                                                                                   | `src/components/TopFundersWidget.tsx`                             | `{savedAt, rows: Funder[]}` — public leaderboard cache                                                             | Low — public on-chain data                                     |
| 21  | `iln_invoice_reminders`                                                                                                 | `src/components/invoice/InvoiceNotificationPrompt.tsx`            | `Record<string, boolean>` — invoice ID → opted-in                                                                  | Low                                                            |
| 22  | `iln_saved_invoice_filters`                                                                                             | `src/components/InvoiceFilterBar.tsx`                             | `SavedFilter[]` — `{id, name, filters}`                                                                            | Low                                                            |
| 23  | `iln:dismissed-parameter-updates`                                                                                       | `src/components/ParameterUpdateBanner.tsx`                        | `string[]` — dismissed announcement IDs                                                                            | Low                                                            |
| 24  | `freelancer_view_mode`                                                                                                  | `src/screens/Dashboard.tsx`                                       | `"table" \| "timeline"`                                                                                            | Low                                                            |
| 25  | `theme`                                                                                                                 | `app/layout.tsx`                                                  | `"dark" \| "light"`                                                                                                | Low                                                            |

---

## Sensitive Key Analysis

### 1. `iln_wallet_address` — Stellar public key

**Risk level: LOW-MEDIUM**

The stored value is a Stellar _public_ key — not a private key, seed, or signing
credential. Stellar public keys are already visible on-chain for any active account,
so exposure via XSS does not grant an attacker asset control. The wallet extension
(Freighter / WalletConnect) holds the private key in its own isolated storage and
never exposes it to page JavaScript.

**Accepted risk:** The address is stored for silent-reconnect convenience and wallet-
scoped cache lookups. An XSS attacker could read it, but the same address is
trivially observable on-chain for any funded account. No further mitigation needed
beyond the existing CSP.

### 2. `iln-notification-subscriptions` — email / webhook targets

**Risk level: MEDIUM**

The `target` field in subscription entries contains plaintext email addresses or
webhook URLs that the user explicitly opted into sharing.

**Mitigation already present:**

- Written only after explicit user opt-in via the notification settings UI.
- Cleared on wallet disconnect (not in `WALLET_SCOPED_PREFIXES`, but the key is
  non-wallet-specific and resets per browser profile).

**Accepted risk:** If XSS were present, the attacker could read these email
addresses. This is a privacy exposure but not a credential leak — the emails are
already shared with the ILN reminder service. The CSP (Issue #16) is the primary
mitigation layer for XSS prevention.

### 3. `iln-address-book-{walletAddress}` — wallet addresses + nicknames

**Risk level: LOW-MEDIUM**

Contains user-supplied nicknames mapped to Stellar addresses. The nicknames are
optional, user-provided PII (e.g. "Alice's Savings").

**Mitigation already present:**

- Scoped per wallet address, page origin and Stellar network; cleared on disconnect via `clearWalletStorage()`.
- SHA-256 integrity digest; corrupt, tampered, cross-scope and expired records are discarded with a user-visible notice.
- 90-day inactivity retention, swept on every app load. See [wallet-storage-integrity.md](./wallet-storage-integrity.md).
- Nicknames are voluntarily entered — the user accepts that they are stored locally.

[AddressBook implementation](../src/hooks/useAddressBook.ts) – ensures proper handling of duplicate entries and max‑size enforcement.
Inline edits from the settings screen (`src/screens/settings/AddressBook.tsx`) go through
`updateAddress()` and are written to this same per-wallet key; no additional storage key is
introduced (#860).

**Accepted risk:** Nicknames are convenience labels, not credentials. Exposure via
XSS is a privacy concern but not a security one. The CSP remains the primary
defense.

### 4. `iln-lp-settings` — LP notification email

**Risk level: MEDIUM**

The `notificationPreferences.email` field stores the user's email in plaintext.

**Mitigation already present:**

- Written only after the user enters their email in the LP settings panel.
- Not wallet-scoped (persists across wallet switches).

**Accepted risk:** Same as subscription email — privacy exposure, not credential
leak. The email is already transmitted to the ILN backend for reminder delivery.

---

## Negative Findings (What Is NOT Stored)

The following sensitive categories are **never written to localStorage**:

| Category                                  | Status                                                                                                                            |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Private keys / seed phrases               | **Not stored** — held exclusively by the wallet extension                                                                         |
| Session tokens / JWTs                     | **Not stored** — wallet signing is handled by Freighter/WalletConnect in their own context; Supabase anon key is public by design |
| Transaction signing payloads              | **Not stored** — passed in-memory only                                                                                            |
| On-chain invoice amounts / financial data | **Not stored** in localStorage (fetched from Soroban RPC / Horizon)                                                               |
| Supabase service role key                 | **Not stored** — server-only via `SUPABASE_SERVICE_ROLE_KEY` env var                                                              |
| WalletConnect session URI / pairing data  | **Not stored** — managed by `@walletconnect/sign-client` internally                                                               |

---

## Disconnect Cleanup

`clearWalletStorage()` in `src/utils/walletStorage.ts` removes:

- `iln_wallet_address`
- `iln_wallet_provider`
- All keys prefixed with: `iln-address-book-`, `iln-watchlist`, `iln-referral-`,
  `iln-invoices-`, `iln-portfolio-`, `freelancerInvoices`

**Note:** The following keys persist across wallet disconnects (they are user-
preferences, not session data):

- `theme`, `freelancer_view_mode`, `iln-notification-subscriptions`,
  `iln-lp-settings`, `iln-sound-prefs`, `iln-bookmarks`, `iln_recent_commands`,
  `iln:last-seen-version`, `iln:dismissed-*`, `iln_invoice_reminders`,
  `iln_saved_invoice_filters`, `iln_lp_widget_layout_*`, `iln_table_config_*`,
  `iln_export_columns_*`, `iln_top_funders_30d`

This is intentional — these are cross-session UI preferences, not session-bound data.

---

## Conclusion

All 25 localStorage keys store non-sensitive UI preferences, layout state, or
public blockchain identifiers. The four keys flagged as sensitive (wallet address,
email addresses, address-book nicknames) contain data that is either already
public on-chain (wallet address) or voluntarily shared with the protocol backend
(emails for reminders). **No private keys, session tokens, or signing credentials
are ever persisted in localStorage.**

The primary XSS mitigation remains the Content Security Policy (Issue #16). This
audit confirms that even under a hypothetical XSS bypass, the attacker would gain
no ability to sign transactions or exfiltrate cryptographic secrets from localStorage.
