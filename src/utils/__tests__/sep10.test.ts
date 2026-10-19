// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, Networks, TransactionBuilder, WebAuth } from '@stellar/stellar-sdk';
import {
  __resetSep10State,
  authenticatedFetch,
  authenticateWithSep10,
  Sep10Error,
  type AuthenticateSep10Options,
} from '../sep10';

const NETWORK = Networks.TESTNET;
let serverKey: Keypair;
let walletKey: Keypair;
let challenge: string;
let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

function jwt(exp: number, subject = walletKey.publicKey()): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ exp, sub: subject })}.signature`;
}

function response(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

// ─── fetchChallenge ───────────────────────────────────────────────────────────

describe('fetchChallenge (#1071)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns transaction and networkPassphrase on a happy path', async () => {
    mockFetch((url) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_OK);
      return jsonResponse({
        transaction: CHALLENGE_XDR,
        network_passphrase: NETWORK_PASSPHRASE,
        home_domain: HOME_DOMAIN,
      });
    });

    const result = await fetchChallenge(HOME_DOMAIN, PUBLIC_KEY);
    expect(result.transaction).toBe(CHALLENGE_XDR);
    expect(result.networkPassphrase).toBe(NETWORK_PASSPHRASE);
  });

  it('requests the challenge with account and home_domain query params', async () => {
    let capturedUrl = '';
    mockFetch((url) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_OK);
      capturedUrl = url;
      return jsonResponse({
        transaction: CHALLENGE_XDR,
        network_passphrase: NETWORK_PASSPHRASE,
        home_domain: HOME_DOMAIN,
      });
    });

    await fetchChallenge(HOME_DOMAIN, PUBLIC_KEY);
    expect(capturedUrl).toContain('account=');
    expect(capturedUrl).toContain('home_domain=');
    expect(capturedUrl).toContain(encodeURIComponent(PUBLIC_KEY));
  });

  it('throws when stellar.toml fetch fails', async () => {
    mockFetch(() => textResponse('Not Found', 404));
    await expect(fetchChallenge(HOME_DOMAIN, PUBLIC_KEY)).rejects.toThrow(/stellar\.toml/);
  });

  it('throws when WEB_AUTH_ENDPOINT is missing from stellar.toml', async () => {
    mockFetch((url) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_NO_AUTH);
      return jsonResponse({});
    });
    await expect(fetchChallenge(HOME_DOMAIN, PUBLIC_KEY)).rejects.toThrow(/WEB_AUTH_ENDPOINT/);
  });

  it('throws when challenge request returns non-ok status', async () => {
    mockFetch((url) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_OK);
      return jsonResponse({ error: 'account not found' }, 400);
    });
    await expect(fetchChallenge(HOME_DOMAIN, PUBLIC_KEY)).rejects.toThrow();
  });

  it('throws when challenge response is missing transaction field', async () => {
    mockFetch((url) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_OK);
      return jsonResponse({ network_passphrase: NETWORK_PASSPHRASE });
    });
    await expect(fetchChallenge(HOME_DOMAIN, PUBLIC_KEY)).rejects.toThrow(/transaction/);
  });

  it('throws when challenge response is missing network_passphrase', async () => {
    mockFetch((url) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_OK);
      return jsonResponse({ transaction: CHALLENGE_XDR });
    });
    await expect(fetchChallenge(HOME_DOMAIN, PUBLIC_KEY)).rejects.toThrow(/network_passphrase/);
  });

  it('throws when home_domain in response does not match requested domain', async () => {
    mockFetch((url) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_OK);
      return jsonResponse({
        transaction: CHALLENGE_XDR,
        network_passphrase: NETWORK_PASSPHRASE,
        home_domain: 'evil.com',
      });
    });
    await expect(fetchChallenge(HOME_DOMAIN, PUBLIC_KEY)).rejects.toThrow(/home_domain mismatch/);
  });

  it('propagates server error field from challenge response', async () => {
    mockFetch((url) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_OK);
      return jsonResponse({ error: 'rate limited' }, 200);
    });
    await expect(fetchChallenge(HOME_DOMAIN, PUBLIC_KEY)).rejects.toThrow(/rate limited/);
  });
});

// ─── signChallenge ────────────────────────────────────────────────────────────

describe('signChallenge (#1072)', () => {
  it('calls signTx with the challenge XDR and returns the signed result', async () => {
    const signTx = vi.fn().mockResolvedValue(SIGNED_XDR);
    const result = await signChallenge(CHALLENGE_XDR, NETWORK_PASSPHRASE, signTx);
    expect(signTx).toHaveBeenCalledWith(CHALLENGE_XDR);
    expect(result).toBe(SIGNED_XDR);
  });

  it('throws when network passphrase does not match NETWORK_PASSPHRASE', async () => {
    const signTx = vi.fn();
    await expect(signChallenge(CHALLENGE_XDR, WRONG_PASSPHRASE, signTx)).rejects.toThrow(
      /network passphrase mismatch/
    );
    expect(signTx).not.toHaveBeenCalled();
  });

  it('does not swallow errors thrown by signTx', async () => {
    const signTx = vi.fn().mockRejectedValue(new Error('USER_REJECTED'));
    await expect(signChallenge(CHALLENGE_XDR, NETWORK_PASSPHRASE, signTx)).rejects.toThrow(
      'USER_REJECTED'
    );
  });
});

// ─── exchangeToken ────────────────────────────────────────────────────────────

describe('exchangeToken (#1073)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns the JWT token from the auth server', async () => {
    mockFetch((url) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_OK);
      return jsonResponse({ token: JWT_TOKEN });
    });

    const result = await exchangeToken(SIGNED_XDR, HOME_DOMAIN);
    expect(result.token).toBe(JWT_TOKEN);
  });

  it('POSTs to WEB_AUTH_ENDPOINT with the signed transaction', async () => {
    let capturedBody = '';
    let capturedMethod = '';
    mockFetch((url, init) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_OK);
      capturedBody = String(init?.body ?? '');
      capturedMethod = String(init?.method ?? '');
      return jsonResponse({ token: JWT_TOKEN });
    });

    await exchangeToken(SIGNED_XDR, HOME_DOMAIN);
    expect(capturedMethod.toUpperCase()).toBe('POST');
    expect(capturedBody).toContain('transaction=');
    expect(capturedBody).toContain(encodeURIComponent(SIGNED_XDR));
  });

  it('throws when stellar.toml fetch fails during exchange', async () => {
    mockFetch(() => textResponse('Not Found', 404));
    await expect(exchangeToken(SIGNED_XDR, HOME_DOMAIN)).rejects.toThrow(/stellar\.toml/);
  });

  it('throws when WEB_AUTH_ENDPOINT is missing from stellar.toml during exchange', async () => {
    mockFetch((url) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_NO_AUTH);
      return jsonResponse({});
    });
    await expect(exchangeToken(SIGNED_XDR, HOME_DOMAIN)).rejects.toThrow(/WEB_AUTH_ENDPOINT/);
  });

  it('throws when token exchange returns non-ok status', async () => {
    mockFetch((url) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_OK);
      return jsonResponse({ error: 'invalid signature' }, 401);
    });
    await expect(exchangeToken(SIGNED_XDR, HOME_DOMAIN)).rejects.toThrow();
  });

  it('throws when token exchange response is missing token field', async () => {
    mockFetch((url) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_OK);
      return jsonResponse({ not_a_token: 'oops' });
    });
    await expect(exchangeToken(SIGNED_XDR, HOME_DOMAIN)).rejects.toThrow(/token/);
  });

  it('propagates server error field from token exchange response', async () => {
    mockFetch((url) => {
      if (url.includes('.well-known/stellar.toml')) return textResponse(STELLAR_TOML_OK);
      return jsonResponse({ error: 'expired challenge' }, 200);
    });
    await expect(exchangeToken(SIGNED_XDR, HOME_DOMAIN)).rejects.toThrow(/expired challenge/);
  });
});
