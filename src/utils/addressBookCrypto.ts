/**
 * addressBookCrypto.ts
 *
 * Encrypts and decrypts address-book entries at rest using AES-GCM (256-bit).
 *
 * Key derivation strategy
 * ────────────────────────
 * A unique AES-GCM key is derived deterministically for each wallet address
 * using HKDF (SHA-256) over the UTF-8 encoded wallet address. Because the
 * key is derived from the address itself, it is:
 *   • Deterministic — survives page reloads and browser restarts.
 *   • Wallet-isolated — data encrypted under wallet A cannot be decrypted
 *     by wallet B, even if they share the same device.
 *   • Non-exportable — SubtleCrypto marks the key as non-extractable.
 *
 * Wire format
 * ───────────
 * Each encrypted payload is a JSON string with two base64url fields:
 *   { iv: "<12-byte IV>", ct: "<AES-GCM ciphertext>" }
 *
 * The IV is freshly generated for every encrypt() call, so two encryptions
 * of identical plaintext produce different ciphertexts (IND-CPA).
 *
 * Error handling
 * ──────────────
 * All public functions are async and throw on failure.  Callers (the hook)
 * are responsible for catching and mapping errors to the PERSIST_FAILED /
 * recovery flow.
 */

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // bytes — recommended for AES-GCM
const INFO = 'iln-address-book-v1'; // HKDF context label

// ── Helpers ──────────────────────────────────────────────────────────────────

function toBase64Url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64Url(s: string): ArrayBuffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Import the wallet address as HKDF key material and derive a non-extractable
 * AES-GCM key.  The same wallet address always yields the same derived key.
 */
export async function deriveKeyFromWalletAddress(walletAddress: string): Promise<CryptoKey> {
  const enc = new TextEncoder();

  // Import the raw wallet address bytes as HKDF source material.
  const rawKeyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(walletAddress),
    { name: 'HKDF' },
    false, // not extractable
    ['deriveKey']
  );

  // Derive a 256-bit AES-GCM key with a fixed salt + info label so the
  // derivation is reproducible but isolated to this application context.
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      // Salt: SHA-256 of the INFO label — stable across environments.
      salt: enc.encode(INFO),
      info: enc.encode(INFO),
    },
    rawKeyMaterial,
    { name: ALGORITHM, length: KEY_LENGTH },
    false, // non-extractable
    ['encrypt', 'decrypt']
  );
}

// ── Encrypt / Decrypt ─────────────────────────────────────────────────────────

/** Encrypted payload stored in localStorage. */
export interface EncryptedPayload {
  iv: string; // base64url-encoded 12-byte IV
  ct: string; // base64url-encoded AES-GCM ciphertext
}

/**
 * Encrypt a UTF-8 string with AES-GCM under the provided key.
 * A fresh random IV is generated for every call.
 */
export async function encryptData(key: CryptoKey, plaintext: string): Promise<EncryptedPayload> {
  const enc = new TextEncoder();
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv },
    key,
    enc.encode(plaintext)
  );

  return {
    iv: toBase64Url(iv.buffer),
    ct: toBase64Url(ciphertext),
  };
}

/**
 * Decrypt an {@link EncryptedPayload} back to a UTF-8 string.
 * Throws `DOMException` (name: "OperationError") on key mismatch or tampered ciphertext.
 */
export async function decryptData(key: CryptoKey, payload: EncryptedPayload): Promise<string> {
  const dec = new TextDecoder();
  const iv = new Uint8Array(fromBase64Url(payload.iv));
  const ct = fromBase64Url(payload.ct);

  const plaintext = await crypto.subtle.decrypt({ name: ALGORITHM, iv }, key, ct);
  return dec.decode(plaintext);
}

// ── High-level helpers used by useAddressBook ─────────────────────────────────

/**
 * Serialize `data` to JSON, encrypt it, and return the stringified
 * {@link EncryptedPayload} ready for `localStorage.setItem`.
 */
export async function encryptForStorage<T>(key: CryptoKey, data: T): Promise<string> {
  const payload = await encryptData(key, JSON.stringify(data));
  return JSON.stringify(payload);
}

/**
 * Parse the stored string, decrypt it, and return the original value.
 * Returns `null` if the stored string is not a valid {@link EncryptedPayload}
 * (e.g., a legacy plaintext entry — see migration note in useAddressBook).
 */
export async function decryptFromStorage<T>(
  key: CryptoKey,
  stored: string
): Promise<T | null> {
  let payload: unknown;
  try {
    payload = JSON.parse(stored);
  } catch {
    return null;
  }

  // Guard: must look like { iv: string, ct: string }
  if (
    typeof payload !== 'object' ||
    payload === null ||
    typeof (payload as EncryptedPayload).iv !== 'string' ||
    typeof (payload as EncryptedPayload).ct !== 'string'
  ) {
    return null;
  }

  const plaintext = await decryptData(key, payload as EncryptedPayload);
  return JSON.parse(plaintext) as T;
}
