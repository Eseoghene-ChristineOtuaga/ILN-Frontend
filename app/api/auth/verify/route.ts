import { NextRequest, NextResponse } from 'next/server';
import jwt from 'jsonwebtoken';
import { NETWORK_PASSPHRASE } from '@/constants';
import { AuthenticationError, isAuthErrorCode } from '@/lib/auth/errors';
import { consumeSEP10Challenge } from '@/lib/auth/challengeStore';
import {
  getSEP10Configuration,
  isValidWalletAddress,
  SEP10_SESSION_TIMEOUT_SECONDS,
  verifySEP10Challenge,
} from '@/lib/auth/sep10';

const PRIVATE_RESPONSE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

export async function POST(request: NextRequest) {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return authError('challenge_invalid', 'Invalid request body', 400);
    }

    const account =
      body && typeof body === 'object' && 'account' in body ? body.account : undefined;
    const signedTransaction =
      body && typeof body === 'object' && 'transaction' in body ? body.transaction : undefined;

    if (typeof account !== 'string' || typeof signedTransaction !== 'string') {
      return authError(
        'challenge_invalid',
        "Missing 'account' or 'transaction' in request body",
        400
      );
    }
    if (!isValidWalletAddress(account)) {
      return authError('authorization_denied', 'Invalid public key format', 400);
    }

    const config = getSEP10Configuration();
    const { transactionHash, expiresAt } = verifySEP10Challenge(signedTransaction, account, config);
    const consumption = await consumeSEP10Challenge(transactionHash, account);
    if (consumption !== 'consumed') {
      const code = consumption === 'expired' ? 'challenge_expired' : 'challenge_replayed';
      return authError(code, 'The authentication challenge is no longer valid', 401);
    }

    const issuedAt = Math.floor(Date.now() / 1000);
    const expiresAtSeconds = issuedAt + SEP10_SESSION_TIMEOUT_SECONDS;
    const token = jwt.sign(
      {
        account,
        network: NETWORK_PASSPHRASE,
        homeDomain: config.homeDomain,
        iat: issuedAt,
        exp: expiresAtSeconds,
      },
      config.jwtSecret,
      {
        algorithm: 'HS256',
        issuer: config.homeDomain,
        audience: config.webAuthDomain,
      }
    );
    const sessionExpiresAt = new Date(expiresAtSeconds * 1000).toISOString();

    return NextResponse.json(
      {
        token,
        expiresAt: sessionExpiresAt,
        challengeExpiresAt: expiresAt,
      },
      { headers: PRIVATE_RESPONSE_HEADERS }
    );
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return authError(error.code, error.message, error.code === 'configuration_error' ? 503 : 401);
    }
    console.error('SEP-10 verification error:', error);
    return authError('exchange_failed', 'Failed to verify authentication challenge', 500);
  }
}

function authError(code: string, message: string, status: number) {
  return NextResponse.json(
    { code: isAuthErrorCode(code) ? code : 'exchange_failed', error: message },
    { status, headers: PRIVATE_RESPONSE_HEADERS }
  );
}
