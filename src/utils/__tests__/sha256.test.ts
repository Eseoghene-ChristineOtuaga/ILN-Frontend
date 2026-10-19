import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sha256Hex } from '../sha256';

const nodeSha256 = (input: string) => createHash('sha256').update(input, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('matches the FIPS 180-4 test vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it.each([
    ['55 bytes (one block)', 'a'.repeat(55)],
    ['56 bytes (length spills into a second block)', 'a'.repeat(56)],
    ['64 bytes (exact block)', 'a'.repeat(64)],
    ['multi-block', 'x'.repeat(1000)],
    ['non-ASCII UTF-8', 'Alice’s Savings — ñandú 💸'],
    ['JSON payload', JSON.stringify([1, 'address-book', { id: 'a', nickname: 'Bob' }])],
  ])('matches node:crypto for %s', (_label, input) => {
    expect(sha256Hex(input)).toBe(nodeSha256(input));
  });
});
