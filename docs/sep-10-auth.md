# SEP-10 authentication deployment

The wallet authentication endpoints implement SEP-10 Web Authentication. They do not treat SEP-41 token metadata, an account's `home_domain`, or any other wallet metadata as proof of identity. A wallet must sign a server-issued SEP-10 challenge on the configured Stellar network.

## Domain and endpoint boundary

- `SEP10_HOME_DOMAIN` is the service home domain. Publish a `stellar.toml` at `https://<SEP10_HOME_DOMAIN>/.well-known/stellar.toml`, including `WEB_AUTH_ENDPOINT=https://<NEXT_PUBLIC_APP_URL hostname>/api/auth/challenge` and the matching `SIGNING_KEY`.
- `NEXT_PUBLIC_APP_URL` is the public URL of this Next.js deployment. Its hostname is used as the SEP-10 `web_auth_domain` in the signed challenge; configure the matching `WEB_AUTH_ENDPOINT` in `stellar.toml`.
- `GET /api/auth/challenge?account=<G...>` creates the challenge. The route signs it with `SEP10_SERVER_SECRET_KEY`, includes the configured home and web-auth domains, and persists its hash and expiry.
- `POST /api/auth/verify` verifies the server and wallet signatures, network, domains, wallet identity, and challenge expiry. It atomically consumes the challenge before issuing a short-lived JWT.
- The JWT is held in memory by `useAuthenticatedWallet`. It is invalidated on disconnect, wallet-address change, network change, or expiry.

The challenge route is not a general-purpose wallet metadata endpoint. The web client must not infer authentication from SEP-41 metadata, token balances, or a connected address alone.

## Server configuration

Set these values in the server deployment environment (and in `.env.local` for local development):

| Variable                         | Purpose                                                                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `SEP10_HOME_DOMAIN`              | Fully qualified service home domain published in `stellar.toml`.                                         |
| `SEP10_SERVER_SECRET_KEY`        | Secret seed corresponding to the SEP-10 `SIGNING_KEY`. Server-only.                                      |
| `NEXT_PUBLIC_APP_URL`            | Public origin of the web-auth endpoint; its hostname is signed into the challenge.                       |
| `NEXT_PUBLIC_NETWORK_PASSPHRASE` | Stellar network passphrase used to build and verify challenges. Must match the connected wallet network. |
| `JWT_SECRET_KEY`                 | Independent secret used to sign 15-minute session JWTs. Server-only.                                     |
| `NEXT_PUBLIC_SUPABASE_URL`       | Supabase project URL used for one-time challenge persistence.                                            |
| `SUPABASE_SERVICE_ROLE_KEY`      | Server-only credential used to atomically consume challenges.                                            |

Do not use real signing or JWT secrets on a public repository, set these values under `NEXT_PUBLIC_*`, log them, or commit them. `JWT_SECRET_KEY` must be at least 32 characters; generate independent high-entropy values using the deployment platform's secret manager.

## Persistent replay protection

Apply [supabase/migrations/002_sep10_auth_challenges.sql](../supabase/migrations/002_sep10_auth_challenges.sql) to each Supabase environment before enabling the endpoints. The table is protected by RLS and has no anon/authenticated grants; only the server-side service-role client accesses it. A challenge is consumed through an atomic delete after SEP-10 verification, so a challenge cannot exchange for multiple sessions. If any required configuration, migration, or database operation is unavailable, the endpoints return an explicit error and do not issue a challenge or JWT.

## Local verification and operations

1. Set the variables listed above in `.env.local`.
2. Apply the migration in the Supabase SQL editor or the deployment's normal migration process.
3. Confirm the server's `stellar.toml` values match the configured home domain, web-auth endpoint, signing key, and network.
4. Connect a wallet on the configured network and exercise challenge, signature rejection, expiry, and replay rejection.
5. Rotate the SEP-10 and JWT secrets through the deployment's secret manager if either is exposed. A JWT secret rotation invalidates existing sessions.

Stable error response codes are documented in [the auth API reference](api-routes.md#apiauthchallenge).
