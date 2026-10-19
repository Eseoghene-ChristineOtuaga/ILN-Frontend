/**
 * Environment variable validation.
 *
 * Provides a `validateEnv()` function to call at app startup for required vars,
 * and typed accessors for all env vars with sensible defaults.
 */

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function booleanEnv(name: string): boolean {
  return process.env[name] === 'true';
}

// ─── Stellar / Contract ────────────────────────────────────────────────────────

export const env = {
  // Supabase – required at runtime, validated by validateEnv()
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '',
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  RESEND_API_KEY: process.env.RESEND_API_KEY || '',
  CRON_SECRET: process.env.CRON_SECRET || '',
  NOTIFICATION_API: process.env.NOTIFICATION_API || '',
  // Indexer REST config is server-only and read solely by src/lib/indexer/server.ts;
  // it is deliberately absent here because this module is reachable from browser code.

  // Stellar / Contract – have testnet defaults in constants.ts but validated here
  NEXT_PUBLIC_CONTRACT_ID: optionalEnv(
    'NEXT_PUBLIC_CONTRACT_ID',
    'CD3TE3IAHM737P236XZL2OYU275ZKD6MN7YH7PYYAXYIGEH55OPEWYJC'
  ),
  NEXT_PUBLIC_NETWORK_PASSPHRASE: optionalEnv(
    'NEXT_PUBLIC_NETWORK_PASSPHRASE',
    'Test SDF Network ; September 2015'
  ),
  NEXT_PUBLIC_RPC_URL: optionalEnv('NEXT_PUBLIC_RPC_URL', 'https://soroban-testnet.stellar.org'),
  NEXT_PUBLIC_NETWORK_NAME: optionalEnv('NEXT_PUBLIC_NETWORK_NAME', 'TESTNET'),
  NEXT_PUBLIC_STELLAR_NETWORK: optionalEnv('NEXT_PUBLIC_STELLAR_NETWORK', 'testnet'),
  NEXT_PUBLIC_SEP10_HOME_DOMAIN: process.env.NEXT_PUBLIC_SEP10_HOME_DOMAIN || '',

  // Tokens
  NEXT_PUBLIC_TESTNET_USDC_TOKEN_ID: optionalEnv(
    'NEXT_PUBLIC_TESTNET_USDC_TOKEN_ID',
    'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
  ),
  NEXT_PUBLIC_TESTNET_EURC_TOKEN_ID: optionalEnv(
    'NEXT_PUBLIC_TESTNET_EURC_TOKEN_ID',
    'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP'
  ),
  NEXT_PUBLIC_TESTNET_XLM_TOKEN_ID: optionalEnv('NEXT_PUBLIC_TESTNET_XLM_TOKEN_ID', 'native-xlm'),

  // Feature flags
  NEXT_PUBLIC_INSURANCE_POOL_ENABLED: booleanEnv('NEXT_PUBLIC_INSURANCE_POOL_ENABLED'),
  NEXT_PUBLIC_ORACLE_ENABLED: booleanEnv('NEXT_PUBLIC_ORACLE_ENABLED'),
  NEXT_PUBLIC_NFT_ENABLED: booleanEnv('NEXT_PUBLIC_NFT_ENABLED'),
  NEXT_PUBLIC_MAINTENANCE_MODE: booleanEnv('NEXT_PUBLIC_MAINTENANCE_MODE'),
  NEXT_PUBLIC_NFT_CONTRACT_ID: process.env.NEXT_PUBLIC_NFT_CONTRACT_ID || '',
  NEXT_PUBLIC_NFT_METADATA_METHOD: optionalEnv('NEXT_PUBLIC_NFT_METADATA_METHOD', 'token_uri'),
  NEXT_PUBLIC_NFT_EVENT_HINTS: process.env.NEXT_PUBLIC_NFT_EVENT_HINTS || '',

  // Governance
  NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID: process.env.NEXT_PUBLIC_GOVERNANCE_CONTRACT_ID || '',
  NEXT_PUBLIC_GOVERNANCE_ADMIN_ADDRESS: optionalEnv(
    'NEXT_PUBLIC_GOVERNANCE_ADMIN_ADDRESS',
    'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF'
  ),

  // Indexer WebSocket (REST access goes through the /api/indexer proxy)
  NEXT_PUBLIC_INDEXER_WS_URL: optionalEnv('NEXT_PUBLIC_INDEXER_WS_URL', 'ws://localhost:8080/ws'),

  // WalletConnect
  NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || '',

  // App
  NEXT_PUBLIC_APP_URL: optionalEnv('NEXT_PUBLIC_APP_URL', 'https://app.iln.finance'),

  // Auth
  SEP10_SERVER_SECRET_KEY: process.env.SEP10_SERVER_SECRET_KEY || '',
  SEP10_HOME_DOMAIN: process.env.SEP10_HOME_DOMAIN || '',
  JWT_SECRET_KEY: process.env.JWT_SECRET_KEY || '',

  // Real-User Monitoring (RUM) – optional beacon endpoint for Core Web Vitals
  NEXT_PUBLIC_RUM_ENDPOINT: process.env.NEXT_PUBLIC_RUM_ENDPOINT || '',

  // GitHub (feedback API)
  GITHUB_TOKEN: process.env.GITHUB_TOKEN || '',
  GITHUB_OWNER: process.env.GITHUB_OWNER || '',
  GITHUB_REPO: process.env.GITHUB_REPO || '',
} as const;

/**
 * Validate that all required env vars are present.
 * Call once at app startup (e.g. in `src/app/layout.tsx` or a server component).
 * Throws a descriptive error listing every missing variable.
 */
export function validateEnv(): void {
  const required = ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'] as const;

  const missing = required.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables:\n` +
        missing.map((n) => `  - ${n}`).join('\n') +
        '\nAdd them to .env.local (see .env.local.example).'
    );
  }
}
