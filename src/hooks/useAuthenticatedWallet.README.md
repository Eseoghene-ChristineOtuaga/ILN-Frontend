# useAuthenticatedWallet Hook

A React hook for wallet connection with Stellar SEP-10 authentication support.

## Overview

`useAuthenticatedWallet()` provides wallet connection, transaction signing, and SEP-10 authentication. It starts authentication after the wallet context reports an active address and network, and invalidates the in-memory JWT when either identity changes.

## Return value

```typescript
interface UseAuthenticatedWalletReturn {
  isConnected: boolean;
  publicKey: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  signTransaction: (txXdr: string) => Promise<string>;
  jwt: string | null;
  authStatus: 'idle' | 'authenticating' | 'authenticated' | 'error';
  authError: AuthErrorCode | null;
  retryAuthentication: () => void;
}
```

`connect()` opens the wallet picker. The hook observes the connected wallet context and starts authentication once it has an address and a matching network. `authStatus` and `authError` expose loading, failure, and recovery state; `retryAuthentication()` repeats the flow for the current identity.

## Security and lifecycle

- The SEP-10 challenge is server-signed, bound to the configured home and web-auth domains, and bound to the configured Stellar network.
- The challenge expires after five minutes and is atomically consumed once before a JWT is issued.
- The JWT is held in hook memory only, expires after 15 minutes, and is bound to the wallet address and network.
- The JWT is cleared on disconnect, address change, network change, expiry, refresh, or browser close.
- SEP-41 token metadata, token balances, and wallet connection alone do not authenticate an identity.

## Error handling

Authentication errors use stable codes such as `wallet_rejected`, `challenge_expired`, `challenge_replayed`, `exchange_failed`, `session_expired`, `network_changed`, and `authorization_denied`. The complete taxonomy and recovery actions are in the [auth API reference](../../docs/api-routes.md#stable-authentication-codes).

```tsx
const { authStatus, authError, retryAuthentication } = useAuthenticatedWallet();

if (authStatus === 'error') {
  return (
    <button onClick={retryAuthentication}>Authentication failed ({authError}). Try again.</button>
  );
}
```

## Deployment configuration

Configure `SEP10_HOME_DOMAIN`, `SEP10_SERVER_SECRET_KEY`, `JWT_SECRET_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_APP_URL`, and the Stellar network passphrase. Apply [the SEP-10 challenge migration](../../supabase/migrations/002_sep10_auth_challenges.sql) before enabling the routes. Secrets must stay server-side and must not use a `NEXT_PUBLIC_` prefix.

See [SEP-10 deployment configuration](../../docs/sep-10-auth.md) for the `stellar.toml` boundary, endpoint setup, replay protection, and operational guidance.

## Testing

Focused hook coverage is in [useAuthenticatedWallet.test.tsx](./__tests__/useAuthenticatedWallet.test.tsx); route coverage is in [auth-api.test.ts](../../__tests__/auth-api.test.ts).
