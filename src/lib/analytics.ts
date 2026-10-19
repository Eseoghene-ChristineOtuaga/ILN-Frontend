'use client';

/**
 * Minimal analytics bridge (#1, wave-9).
 * Emits a DOM CustomEvent so any sink (or a test) can observe product events
 * without the app taking a hard dependency on a specific analytics provider.
 *
 * Privacy & Telemetry Redaction:
 * Audits and redacts wallet addresses, user nicknames, and provider state
 * from telemetry before events are dispatched.
 */

export const ANALYTICS_EVENT = 'iln:analytics';

export const REDACTED_ADDRESS = '[REDACTED_ADDRESS]';
export const REDACTED_NICKNAME = '[REDACTED_NICKNAME]';
export const REDACTED_PROVIDER_STATE = '[REDACTED_PROVIDER_STATE]';

export interface AnalyticsPayload {
  name: string;
  props?: Record<string, unknown>;
}

/** Stellar public address (G...) or contract ID (C...) 56 alphanumeric characters */
const STELLAR_ADDRESS_REGEX = /(^|[^A-Za-z0-9])([GC][A-Za-z0-9]{55})(?![A-Za-z0-9])/g;

/** Keys that represent wallet addresses and should be redacted */
const SENSITIVE_ADDRESS_KEYS = new Set([
  'address',
  'addresses',
  'walletaddress',
  'wallet_address',
  'publickey',
  'public_key',
  'account',
  'accounts',
  'accountid',
  'account_id',
  'signer',
  'signers',
  'signeraddress',
  'signer_address',
  'recipient',
  'recipients',
  'recipientaddress',
  'recipient_address',
  'sender',
  'senders',
  'senderaddress',
  'sender_address',
  'funder',
  'funders',
  'funderaddress',
  'funder_address',
  'freelancer',
  'freelancers',
  'freelanceraddress',
  'freelancer_address',
  'payer',
  'payers',
  'payeraddress',
  'payer_address',
  'useraddress',
  'user_address',
]);

/** Keys that represent user nicknames and contact names */
const SENSITIVE_NICKNAME_KEYS = new Set([
  'nickname',
  'nicknames',
  'nick_name',
  'contactname',
  'contact_name',
  'entrynickname',
  'entry_nickname',
  'usernickname',
  'user_nickname',
]);

/** Keys that represent provider internal state, session data, or secrets */
const SENSITIVE_PROVIDER_STATE_KEYS = new Set([
  'providerstate',
  'provider_state',
  'sessiondata',
  'session_data',
  'sessionuri',
  'session_uri',
  'sessiontopic',
  'session_topic',
  'pairingtopic',
  'pairing_topic',
  'connectionstate',
  'connection_state',
  'walletstate',
  'wallet_state',
  'privatekey',
  'private_key',
  'secret',
  'secretkey',
  'secret_key',
  'mnemonic',
  'seedphrase',
  'seed_phrase',
]);

/** Allowed string values for the 'provider' field */
const SAFE_PROVIDER_VALUES = new Set(['freighter', 'walletconnect', 'none', 'unknown']);

function redactString(val: string): string {
  return val.replace(STELLAR_ADDRESS_REGEX, `$1${REDACTED_ADDRESS}`);
}

/**
 * Recursively redacts sensitive wallet data, nicknames, and provider state from telemetry objects.
 */
export function redactTelemetryValue(
  key: string,
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  const normalizedKey = key.toLowerCase().replace(/[-_]/g, '');

  // 1. Redact provider state / secrets
  if (SENSITIVE_PROVIDER_STATE_KEYS.has(normalizedKey)) {
    return REDACTED_PROVIDER_STATE;
  }

  // 2. Handle provider property
  if (normalizedKey === 'provider') {
    if (typeof value === 'string' && SAFE_PROVIDER_VALUES.has(value.toLowerCase())) {
      return value;
    }
    return REDACTED_PROVIDER_STATE;
  }

  // 3. Array handling
  if (Array.isArray(value)) {
    return value.map((item, idx) => redactTelemetryValue(String(idx), item, seen));
  }

  // 4. Redact user nicknames
  if (SENSITIVE_NICKNAME_KEYS.has(normalizedKey)) {
    return REDACTED_NICKNAME;
  }

  // 5. Redact wallet addresses
  if (SENSITIVE_ADDRESS_KEYS.has(normalizedKey)) {
    return REDACTED_ADDRESS;
  }

  // 6. String value: check for embedded Stellar addresses
  if (typeof value === 'string') {
    return redactString(value);
  }

  // 7. Object handling (with cycle protection)
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }
    seen.add(value);

    const redactedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      redactedObj[k] = redactTelemetryValue(k, v, seen);
    }
    return redactedObj;
  }

  return value;
}

/**
 * Sanitizes an analytics props dictionary before dispatch.
 */
export function redactTelemetryPayload(
  props?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!props) return undefined;
  return redactTelemetryValue('root', props) as Record<string, unknown>;
}

export function trackEvent(name: string, props?: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;

  const sanitizedName = redactString(name);
  const sanitizedProps = redactTelemetryPayload(props);

  window.dispatchEvent(
    new CustomEvent<AnalyticsPayload>(ANALYTICS_EVENT, {
      detail: { name: sanitizedName, props: sanitizedProps },
    })
  );
}
