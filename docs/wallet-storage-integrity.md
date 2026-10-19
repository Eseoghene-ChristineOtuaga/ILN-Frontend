# Wallet Storage Integrity, Expiry and Isolation

Covers #1087 (integrity), #1088 (expiry), #1089 (origin/network isolation) and
#1097 (tamper recovery tests). Implementation: `src/utils/walletRecordStore.ts`.

## Record format

Wallet-linked records are stored as an envelope:

```json
{
  "v": 1,
  "kind": "address-book",
  "scope": { "origin": "https://app.example", "network": "<network passphrase>", "wallet": "G…" },
  "savedAt": 1767225600000,
  "expiresAt": 1774992000000,
  "data": [{ "id": "…", "address": "G…", "nickname": "…" }],
  "digest": "<sha-256 hex>"
}
```

`digest` is SHA-256 over the fixed-order JSON array
`[v, kind, origin, network, wallet, savedAt, expiresAt, data]`.

Storage key: `iln-address-book-v1-<tag>-<wallet>`, where `<tag>` is the first
12 hex characters of `sha256(origin + "\n" + networkPassphrase)`. The
`iln-address-book-` prefix is kept so `clearWalletStorage()` still removes it
on disconnect.

## Read checks

A record is returned to the caller only if all checks pass. Otherwise it is
**removed** and the read returns `{ status: 'rejected', reason }`:

| Reason                | Trigger                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------- |
| `CORRUPT`             | Not JSON, or not an envelope                                                              |
| `UNSUPPORTED_VERSION` | `v` is not the current schema version                                                     |
| `TAMPERED`            | Digest mismatch, or `expiresAt - savedAt` exceeds the retention policy                    |
| `SCOPE_MISMATCH`      | Envelope kind/origin/network/wallet differs from the reader's scope                       |
| `EXPIRED`             | `now >= expiresAt`                                                                        |
| `INVALID_SHAPE`       | Payload fails the kind's validator (address book: ≤ 50 `{id, address, nickname}` strings) |

If storage itself throws on read, the result is `{ status: 'unavailable' }` and
nothing is overwritten.

`useAddressBook` exposes this as `status` (`idle | loading | ready | unavailable`)
and `recovery` (the rejection reason, or `null`). The settings screen shows a
dismissible `role="alert"` notice when a record was discarded, and a separate
alert when storage is unavailable.

## Retention windows

| Kind           | Window  | Clock starts                                                                                                                                    |
| -------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `address-book` | 90 days | Last write. Loading the address book re-writes it, so the window is effectively 90 days of inactivity for that wallet + network on this origin. |

Expired records are removed:

- on read, by `readWalletRecord()`;
- on every app load, by `purgeExpiredWalletRecords()` (called from
  `WalletProvider`), for every wallet and network — records that are still
  valid for another wallet or network are kept;
- on disconnect, together with all other wallet-scoped data, by
  `clearWalletStorage()`.

To change a window, edit `WALLET_RECORD_RETENTION_MS`. Shortening it takes
effect on the next read; records written under a longer window fail the
lifetime check and are discarded as `TAMPERED`.

## Migration

Pre-envelope records at `iln-address-book-<wallet>` are validated, re-written
as an envelope under the current origin/network scope, and the legacy key is
removed after the new write succeeds. Invalid legacy records are removed and
reported as `CORRUPT` / `INVALID_SHAPE`.

## Threat model

The digest detects corruption, manual or extension edits, and records copied
between wallets, networks or origins. It is **not** a keyed MAC: any script
running on this origin can recompute it, and can also plant a legacy-format
record that gets migrated. Defending against script injection remains the job
of the CSP — see [localstorage-sensitivity-audit.md](./localstorage-sensitivity-audit.md).

## Baseline (before / after)

The same scenarios were run against the address book hook on `dev` before this
change and against the new envelope format after it.

| Scenario                          | Before                           | After                                                             |
| --------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| Stored contact address swapped    | Loaded into UI                   | Rejected `TAMPERED`, removed, user notified                       |
| Corrupt JSON                      | Silently emptied, no signal      | Rejected `CORRUPT`, removed, user notified                        |
| Wrong shape (`{"evil":1}`)        | Loaded as a non-array into state | Rejected `INVALID_SHAPE`, removed, user notified                  |
| Record copied from another wallet | Loaded into UI                   | Rejected `SCOPE_MISMATCH`, removed, user notified                 |
| Same wallet, different network    | Shared one key across networks   | Separate key per network; copied record rejected `SCOPE_MISMATCH` |
| Record unused for 400 days        | Loaded into UI (no expiry)       | Rejected `EXPIRED`, removed, user notified                        |

## Tests

- `src/utils/__tests__/sha256.test.ts` — FIPS vectors and cross-check against `node:crypto`.
- `src/utils/__tests__/walletRecordStore.test.ts` — integrity, expiry, isolation, migration and storage-failure fixtures.
- `src/hooks/__tests__/useAddressBook.recovery.test.ts` — hook status, recovery reasons, re-save after discard, per-wallet isolation, sliding retention.
- `src/screens/settings/__tests__/AddressBook.recovery.test.tsx` — tampered entries are never rendered; accessible alert is dismissible.
- `e2e/wallet-storage-integrity.spec.ts` — in-browser sweep on load removes corrupt/tampered/expired records and keeps valid ones for other wallets/networks.
