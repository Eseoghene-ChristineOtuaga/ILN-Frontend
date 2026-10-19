export const AUTH_ERROR_CODES = [
  'wallet_not_connected',
  'wallet_rejected',
  'wallet_unavailable',
  'wallet_identity_changed',
  'network_changed',
  'challenge_invalid',
  'challenge_expired',
  'challenge_replayed',
  'exchange_failed',
  'session_expired',
  'authorization_denied',
  'configuration_error',
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

const AUTH_ERROR_CODE_SET: ReadonlySet<string> = new Set(AUTH_ERROR_CODES);

export class AuthenticationError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

export function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return typeof value === 'string' && AUTH_ERROR_CODE_SET.has(value);
}

export function getWalletErrorCode(error: unknown): AuthErrorCode {
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : error &&
          typeof error === 'object' &&
          'message' in error &&
          typeof error.message === 'string'
        ? error.message.toLowerCase()
        : String(error).toLowerCase();

  if (/reject|denied|declin|cancel/.test(message)) return 'wallet_rejected';
  if (/install|not found|unavailable/.test(message)) return 'wallet_unavailable';
  return 'wallet_not_connected';
}

export function getAuthResponseCode(payload: unknown, fallback: AuthErrorCode): AuthErrorCode {
  if (payload && typeof payload === 'object' && 'code' in payload) {
    const { code } = payload;
    if (isAuthErrorCode(code)) return code;
  }

  return fallback;
}
