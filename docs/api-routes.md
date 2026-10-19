# API routes reference

This document summarizes the server routes in [app/api](../app/api) that are used by the frontend for reminders, authentication, feedback, and notification lookups.

## `/api/reminders`

### `POST`

Saves or updates the reminder opt-in preference for a wallet address.

- Request body:
  ```json
  {
    "address": "G...",
    "email": "payer@example.com",
    "enabled": true
  }
  ```
- Response:
  ```json
  { "success": true }
  ```
- Auth requirement: none. The route uses the Supabase admin client on the server.
- Validation: `address` must be a well-formed Ed25519 Stellar public key (`StrKey.isValidEd25519PublicKey`); `email` must match a basic email shape and stay under 320 characters; `enabled`, if present, must be a boolean.
- Rate limit: 5 requests per minute per client IP (see [Rate limits and operational notes](#rate-limits-and-operational-notes)).
- Error responses:
  - `400` when `address` or `email` is missing or malformed.
  - `429` when the rate limit is exceeded.
  - `500` when the Supabase upsert fails.

### `GET`

Triggers reminder emails for active preferences. This is intended for a cron job or manual admin run.

- Auth requirement: `Authorization: Bearer <CRON_SECRET>`.
- Rate limit: 10 requests per minute per client IP, applied after the `CRON_SECRET` check.
- Response:
  ```json
  {
    "success": true,
    "sentCount": 1,
    "details": [
      {
        "invoiceId": "42",
        "milestone": 24,
        "email": "payer@example.com"
      }
    ]
  }
  ```
- Error responses:
  - `401` when the bearer token does not match `CRON_SECRET`.
  - `429` when the rate limit is exceeded.
  - `200` with `{ "message": "No active preferences" }` when no reminder preferences are enabled.
  - `500` on internal failures.

Example curl:

```bash
curl -X GET "http://localhost:3000/api/reminders" \
  -H "Authorization: Bearer $CRON_SECRET"
```

## `/api/reminders/unsubscribe`

### `GET`

Disables reminder delivery for a wallet address.

- Query string: `?address=<wallet-address>`
- Response: HTML page that confirms the unsubscribe.
- Auth requirement: none.
- Error responses:
  - `400` when the `address` query parameter is missing.
  - `500` when the update fails.

Example curl:

```bash
curl "http://localhost:3000/api/reminders/unsubscribe?address=G..."
```

## `/api/auth/challenge`

### `GET`

Generates a standards-compliant SEP-10 challenge transaction for the configured home domain and issuing web-auth domain. It is server-signed, network-bound, expires after five minutes, and is recorded for one-time use.

- Query string: `?account=<stellar-public-key>`
- Response:
  ```json
  { "challenge": "<base64-transaction-envelope>", "expiresAt": "<ISO-8601 timestamp>" }
  ```
- Auth requirement: none; the route is used as a wallet-signing helper.
- Error responses use `{ "code": "<stable-auth-code>", "error": "<message>" }`:
  - `400` with `authorization_denied` when `account` is missing or invalid.
  - `503` with `configuration_error` when SEP-10 or persistent challenge storage is not configured.
  - `500` with `exchange_failed` when generation or challenge persistence fails.

Example curl:

```bash
curl "http://localhost:3000/api/auth/challenge?account=G..."
```

## `/api/auth/verify`

### `POST`

Verifies a signed SEP-10 challenge against the configured server key, home domain, web-auth domain, network, wallet address, expiry, and one-time challenge record; then returns a 15-minute JWT bound to the wallet and network.

- Request body:
  ```json
  {
    "account": "G...",
    "transaction": "AAAA..."
  }
  ```
- Response:
  ```json
  { "token": "<jwt>", "expiresAt": "<ISO-8601 timestamp>" }
  ```
- Auth requirement: none.
- Error responses use `{ "code": "<stable-auth-code>", "error": "<message>" }`:
  - `400` with `challenge_invalid` for a malformed request or challenge.
  - `401` with `authorization_denied` for wallet/signature mismatch, `challenge_expired` for an expired challenge, or `challenge_replayed` for a previously consumed challenge.
  - `503` with `configuration_error` when SEP-10 configuration is incomplete.
  - `500` with `exchange_failed` for unexpected verification failures.

See [SEP-10 deployment configuration](sep-10-auth.md) for the domain, secret, and database setup. SEP-41 token metadata (including account or issuer metadata) is not authentication; this UI auth path requires a valid SEP-10 challenge signature.

### Stable authentication codes

| Code                      | Meaning and recovery                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------ |
| `wallet_not_connected`    | Connect a wallet before signing or requesting an authenticated action.                     |
| `wallet_rejected`         | The wallet rejected signing; the user can retry.                                           |
| `wallet_unavailable`      | Install or unlock the supported wallet.                                                    |
| `wallet_identity_changed` | The connected wallet changed; authenticate the new identity.                               |
| `network_changed`         | The wallet network changed or does not match the application configuration.                |
| `challenge_invalid`       | The challenge request or transaction is invalid; request a new challenge.                  |
| `challenge_expired`       | The five-minute challenge expired; request a new one.                                      |
| `challenge_replayed`      | The challenge was already consumed; request a new one.                                     |
| `exchange_failed`         | Challenge generation, persistence, or token exchange failed; retry after service recovery. |
| `session_expired`         | The 15-minute JWT expired; authenticate again.                                             |
| `authorization_denied`    | The wallet identity or signature did not meet SEP-10 requirements.                         |
| `configuration_error`     | Required deployment configuration or persistent storage is missing.                        |

Example curl:

```bash
curl -X POST "http://localhost:3000/api/auth/verify" \
  -H "Content-Type: application/json" \
  -d '{"account":"G...","transaction":"AAAA..."}'
```

## `/api/feedback`

### `POST`

Accepts feedback from the UI and forwards it to GitHub issues when GitHub credentials are configured.

- Request body:
  ```json
  {
    "rating": 5,
    "category": "Bug",
    "feedback": "The dashboard feels slow",
    "email": "user@example.com"
  }
  ```
- Response:
  - Success without GitHub config: `{ "success": true }`
  - Success with GitHub config: `{ "success": true, "issueUrl": "https://github.com/..." }`
- Auth requirement: none.
- Validation: `rating` must be an integer 1-5, `category` must be one of `Bug`, `Feature`, `UX`, `Other`, `feedback` must be a non-empty string under 5,000 characters, and `email` (if provided) must be a valid email under 320 characters.
- Rate limit: 5 requests per minute per client IP.
- Error responses:
  - `400` when a required field is missing or fails validation.
  - `429` when the local rate limit is exceeded, or when GitHub returns a rate-limit response; the body includes `error: "rate_limit"` and `retryAfter`.
  - `500` for unexpected failures.

Example curl:

```bash
curl -X POST "http://localhost:3000/api/feedback" \
  -H "Content-Type: application/json" \
  -d '{"rating":5,"category":"Bug","feedback":"The dashboard feels slow","email":"user@example.com"}'
```

## `/api/notifications/[address]`

### `GET`

Returns the notification list for a given wallet address.

- Path parameter: `/api/notifications/<address>`
- Response: a JSON array of notification objects with the shape:
  ```json
  [
    {
      "id": "1",
      "category": "invoice",
      "type": "overdue",
      "title": "Invoice overdue",
      "message": "A funded invoice is now overdue",
      "href": "/pay/42",
      "createdAt": "2026-07-26T00:00:00.000Z",
      "read": false
    }
  ]
  ```
- Auth requirement: none.
- Validation: the `address` path segment must be a well-formed Ed25519 Stellar public key; requests with a malformed address are rejected with `400` before reaching the notification backend.
- Rate limit: 30 requests per minute per client IP.
- Error responses:
  - `400` when `address` is not a valid Stellar public key.
  - `429` when the rate limit is exceeded.
  - The route returns an empty array `[]` if notification fetching fails or the upstream service is not configured.

Example curl:

```bash
curl "http://localhost:3000/api/notifications/G..."
```

## `/api/leaderboard`

### `GET`

Returns leaderboard entries for LPs, payers, or freelancers over a given period. This route lives at
[app/api/leaderboard/route.ts](../app/api/leaderboard/route.ts) and backs `TopFundersWidget`.

- Query string: `?type=<lp|payer|freelancer>&period=<7d|30d|90d|all>&limit=<1-100>`
- Response: a JSON array of leaderboard entries, or `[]` if the upstream indexer request fails.
- Auth requirement: none.
- Validation: `type` and `period` are checked against fixed allow-lists; `limit`, if provided, must be an integer between 1 and 100.
- Rate limit: 30 requests per minute per client IP.
- Error responses:
  - `400` when `type`, `period`, or `limit` is invalid.
  - `429` when the rate limit is exceeded.

Example curl:

```bash
curl "http://localhost:3000/api/leaderboard?type=lp&period=30d&limit=10"
```

## Rate limits and operational notes

- All routes above (`reminders`, `feedback`, `notifications/[address]`, `leaderboard`) apply an in-memory,
  per-client-IP rate limit via [src/lib/rate-limit.ts](../src/lib/rate-limit.ts). This is a best-effort,
  per-instance fixed window - it does not share state across serverless instances or regions, so it should be
  treated as defense-in-depth rather than a hard guarantee. If stricter enforcement becomes necessary (e.g. under
  active abuse), replace it with a shared store such as Upstash Redis.
- The reminders `GET` route additionally requires `CRON_SECRET`; treat it as a privileged endpoint and keep it
  behind a scheduler rather than exposing it to end users.
- The feedback route inherits GitHub API rate limits and returns a `429` response if the upstream API refuses the request.
- All routes return generic, non-identifying error messages to callers; detailed errors are only logged server-side via `console.error`, never included in the response body.
