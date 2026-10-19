/**
 * addressBookCrypto utility tests — #1086
 *
 * Verifies:
 *  - Key derivation is deterministic per wallet address
 *  - Keys are wallet-isolated (wallet-A key ≠ wallet-B key)
 *  - Encrypt/decrypt round-trips correctly
 *  - Each encrypt call produces a different IV (IND-CPA)
 *  - Decryption with the wrong key throws
 *  - encryptForStorage / decryptFromStorage handle the full JSON lifecycle
 *  - decryptFromStorage returns null for non-EncryptedPayload input
 */
import { describe, expect, it } from 'vitest';
import {
  deriveKeyFromWalletAddress,
  encryptData,
  decryptData,
  encryptForStorage,
  decryptFromStorage,
} from '../addressBookCrypto';

const WALLET_A = 'GDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXABCD';
const WALLET_B = 'GEYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYYEFGH';

describe('deriveKeyFromWalletAddress', () => {
  it('returns a CryptoKey object', async () => {
    const key = await deriveKeyFromWalletAddress(WALLET_A);
    expect(key).toBeDefined();
    expect(key.type).toBe('secret');
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM' });
  });

  it('is deterministic — same address produces the same encryption result', async () => {
    const key1 = await deriveKeyFromWalletAddress(WALLET_A);
    const key2 = await deriveKeyFromWalletAddress(WALLET_A);

    // We can't compare CryptoKey objects directly (non-extractable), but we
    // can verify that both keys decrypt what the other encrypts.
    const { iv, ct } = await encryptData(key1, 'hello');
    const plaintext = await decryptData(key2, { iv, ct });
    expect(plaintext).toBe('hello');
  });

  it('produces wallet-isolated keys — wallet-B key cannot decrypt wallet-A ciphertext', async () => {
    const keyA = await deriveKeyFromWalletAddress(WALLET_A);
    const keyB = await deriveKeyFromWalletAddress(WALLET_B);

    const payload = await encryptData(keyA, 'secret data');
    await expect(decryptData(keyB, payload)).rejects.toThrow();
  });
});

describe('encryptData / decryptData', () => {
  it('round-trips arbitrary plaintext', async () => {
    const key = await deriveKeyFromWalletAddress(WALLET_A);
    const original = 'Hello, Stellar! 🚀';
    const payload = await encryptData(key, original);
    const recovered = await decryptData(key, payload);
    expect(recovered).toBe(original);
  });

  it('generates a different IV on each call (IND-CPA)', async () => {
    const key = await deriveKeyFromWalletAddress(WALLET_A);
    const p1 = await encryptData(key, 'same plaintext');
    const p2 = await encryptData(key, 'same plaintext');
    expect(p1.iv).not.toBe(p2.iv);
    expect(p1.ct).not.toBe(p2.ct);
  });

  it('produces base64url-encoded iv and ct fields', async () => {
    const key = await deriveKeyFromWalletAddress(WALLET_A);
    const { iv, ct } = await encryptData(key, 'test');
    // base64url uses - and _ instead of + and /
    expect(iv).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(ct).toMatch(/^[A-Za-z0-9\-_]+$/);
    // No padding
    expect(iv).not.toContain('=');
    expect(ct).not.toContain('=');
  });

  it('throws on tampered ciphertext', async () => {
    const key = await deriveKeyFromWalletAddress(WALLET_A);
    const payload = await encryptData(key, 'original');
    // Corrupt the ciphertext by changing one character
    const tampered = { ...payload, ct: payload.ct.slice(0, -3) + 'XXX' };
    await expect(decryptData(key, tampered)).rejects.toThrow();
  });
});

describe('encryptForStorage / decryptFromStorage', () => {
  it('round-trips an array of address-book entries', async () => {
    const key = await deriveKeyFromWalletAddress(WALLET_A);
    const entries = [
      { id: '1', address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC', nickname: 'Alice' },
      { id: '2', address: 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD', nickname: 'Bob' },
    ];

    const stored = await encryptForStorage(key, entries);
    const recovered = await decryptFromStorage<typeof entries>(key, stored);

    expect(recovered).toEqual(entries);
  });

  it('encryptForStorage produces a valid JSON EncryptedPayload string', async () => {
    const key = await deriveKeyFromWalletAddress(WALLET_A);
    const stored = await encryptForStorage(key, { foo: 'bar' });
    const parsed = JSON.parse(stored);
    expect(parsed).toHaveProperty('iv');
    expect(parsed).toHaveProperty('ct');
  });

  it('decryptFromStorage returns null for a raw JSON array (non-EncryptedPayload)', async () => {
    const key = await deriveKeyFromWalletAddress(WALLET_A);
    const legacyJson = JSON.stringify([{ id: '1', address: 'G' + 'A'.repeat(55), nickname: 'Old' }]);
    const result = await decryptFromStorage(key, legacyJson);
    expect(result).toBeNull();
  });

  it('decryptFromStorage returns null for unparseable input', async () => {
    const key = await deriveKeyFromWalletAddress(WALLET_A);
    const result = await decryptFromStorage(key, 'not-json!!!');
    expect(result).toBeNull();
  });

  it('decryptFromStorage returns null for a JSON object without iv/ct fields', async () => {
    const key = await deriveKeyFromWalletAddress(WALLET_A);
    const result = await decryptFromStorage(key, JSON.stringify({ some: 'other', data: 1 }));
    expect(result).toBeNull();
  });

  it('decryptFromStorage throws for a valid-looking payload with wrong key', async () => {
    const keyA = await deriveKeyFromWalletAddress(WALLET_A);
    const keyB = await deriveKeyFromWalletAddress(WALLET_B);
    const stored = await encryptForStorage(keyA, { secret: 'value' });
    await expect(decryptFromStorage(keyB, stored)).rejects.toThrow();
  });
});
