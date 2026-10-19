// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { Keypair, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import jwt from 'jsonwebtoken';
import { GET } from '../app/api/auth/challenge/route';
import { POST } from '../app/api/auth/verify/route';
import { NETWORK_PASSPHRASE } from '@/constants';

const challengeStore = vi.hoisted(() => ({
  store: vi.fn(),
  consume: vi.fn(),
}));

vi.mock('@/lib/auth/challengeStore', () => ({
  storeSEP10Challenge: challengeStore.store,
  consumeSEP10Challenge: challengeStore.consume,
}));

describe('/api/auth SEP-10 endpoints', () => {
  let serverKeypair: Keypair;
  let walletKeypair: Keypair;
  const records = new Map<string, { account: string; expiresAt: string }>();
  const jwtSecret = 'test-only-jwt-secret-with-enough-entropy';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    records.clear();
    serverKeypair = Keypair.fromSecret('SAFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUCQKBIFAUTEK');
    walletKeypair = Keypair.fromSecret('SAFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQX44I');
    process.env.SEP10_SERVER_SECRET_KEY = serverKeypair.secret();
    process.env.SEP10_HOME_DOMAIN = 'auth.example.test';
    process.env.JWT_SECRET_KEY = jwtSecret;
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example.test';
    challengeStore.store.mockImplementation(
      async (hash: string, account: string, expiresAt: string) => {
        records.set(hash, { account, expiresAt });
      }
    );
    challengeStore.consume.mockImplementation(async (hash: string, account: string) => {
      const record = records.get(hash);
      if (!record) return 'replayed';
      if (record.account !== account) return 'replayed';
      if (Date.parse(record.expiresAt) <= Date.now()) return 'expired';
      records.delete(hash);
      return 'consumed';
    });
  });

  async function issueChallenge(account = walletKeypair.publicKey()) {
    const response = await GET(
      new NextRequest(`http://localhost/api/auth/challenge?account=${encodeURIComponent(account)}`)
    );
    return { response, body: await response.json() };
  }

  function signChallenge(challenge: string, signer: Keypair): string {
    const transaction = TransactionBuilder.fromXDR(challenge, NETWORK_PASSPHRASE);
    transaction.sign(signer);
    return transaction.toEnvelope().toXDR('base64').toString();
  }

  async function verifyChallenge(account: string, transaction: string) {
    return POST(
      new NextRequest('http://localhost/api/auth/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account, transaction }),
      })
    );
  }

  it('creates a domain-bound, server-signed SEP-10 challenge', async () => {
    const { response, body } = await issueChallenge();

    expect(response.status).toBe(200);
    expect(typeof body.challenge).toBe('string');
    expect(body.expiresAt).toBeDefined();
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    expect(challengeStore.store).toHaveBeenCalledOnce();

    const parsed = WebAuth.readChallengeTx(
      body.challenge,
      serverKeypair.publicKey(),
      NETWORK_PASSPHRASE,
      'auth.example.test',
      'app.example.test'
    );
    expect(parsed.clientAccountID).toBe(walletKeypair.publicKey());
  });

  it('returns stable codes for missing and invalid wallet identities', async () => {
    const missing = await GET(new NextRequest('http://localhost/api/auth/challenge'));
    const invalid = await GET(
      new NextRequest('http://localhost/api/auth/challenge?account=invalid_key')
    );

    expect(missing.status).toBe(400);
    await expect(missing.json()).resolves.toMatchObject({ code: 'authorization_denied' });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({ code: 'authorization_denied' });
  });

  it('fails explicitly when SEP-10 server configuration is missing', async () => {
    delete process.env.SEP10_SERVER_SECRET_KEY;
    const { response, body } = await issueChallenge();

    expect(response.status).toBe(503);
    expect(body.code).toBe('configuration_error');
  });

  it('rejects a signed challenge when the wallet signature is not authorized', async () => {
    const { body } = await issueChallenge();
    const alternateWallet = Keypair.fromSecret(
      'SAGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAZTUF'
    );
    const signed = signChallenge(body.challenge, alternateWallet);
    const response = await verifyChallenge(walletKeypair.publicKey(), signed);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'authorization_denied' });
  });

  it('rejects a valid challenge when the submitted wallet identity differs', async () => {
    const { body } = await issueChallenge();
    const signed = signChallenge(body.challenge, walletKeypair);
    const otherWallet = Keypair.fromSecret(
      'SAGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAZTUF'
    );
    const response = await verifyChallenge(otherWallet.publicKey(), signed);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'authorization_denied' });
  });

  it('rejects malformed and unsigned transactions', async () => {
    const malformed = await verifyChallenge(walletKeypair.publicKey(), 'not-xdr');
    expect(malformed.status).toBe(401);
    await expect(malformed.json()).resolves.toMatchObject({ code: 'challenge_invalid' });

    const { body } = await issueChallenge();
    const unsigned = await verifyChallenge(walletKeypair.publicKey(), body.challenge);
    expect(unsigned.status).toBe(401);
    await expect(unsigned.json()).resolves.toMatchObject({ code: 'authorization_denied' });
  });

  it('rejects expired challenges', async () => {
    const { body } = await issueChallenge();
    const signed = signChallenge(body.challenge, walletKeypair);
    vi.setSystemTime(Date.now() + 301_000);
    const response = await verifyChallenge(walletKeypair.publicKey(), signed);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ code: 'challenge_expired' });
    expect(challengeStore.consume).toHaveBeenCalledOnce();
  });

  it('issues a short-lived wallet-bound JWT once and rejects replay', async () => {
    const { body } = await issueChallenge();
    const signed = signChallenge(body.challenge, walletKeypair);
    const response = await verifyChallenge(walletKeypair.publicKey(), signed);
    const tokenBody = await response.json();

    expect(response.status).toBe(200);
    expect(tokenBody.expiresAt).toBeDefined();
    const sessionClaims = jwt.verify(tokenBody.token, jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'auth.example.test',
      audience: 'app.example.test',
    }) as jwt.JwtPayload;
    expect(sessionClaims).toMatchObject({
      account: walletKeypair.publicKey(),
      homeDomain: 'auth.example.test',
      network: NETWORK_PASSPHRASE,
    });
    expect(Number(sessionClaims.exp) - Number(sessionClaims.iat)).toBe(15 * 60);

    const replay = await verifyChallenge(walletKeypair.publicKey(), signed);
    expect(replay.status).toBe(401);
    await expect(replay.json()).resolves.toMatchObject({ code: 'challenge_replayed' });
  });

  it('does not issue a token if durable challenge storage fails', async () => {
    challengeStore.store.mockRejectedValueOnce(new Error('storage unavailable'));
    const { response, body } = await issueChallenge();

    expect(response.status).toBe(500);
    expect(body.code).toBe('exchange_failed');
    expect(body.challenge).toBeUndefined();
  });
});
