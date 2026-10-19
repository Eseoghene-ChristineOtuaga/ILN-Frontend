import { NextRequest, NextResponse } from 'next/server';
import { AuthenticationError, isAuthErrorCode } from '@/lib/auth/errors';
import { storeSEP10Challenge } from '@/lib/auth/challengeStore';
import { buildSEP10Challenge, getSEP10Configuration, isValidWalletAddress } from '@/lib/auth/sep10';

const PRIVATE_RESPONSE_HEADERS = { 'Cache-Control': 'no-store, max-age=0' };

/**
 * SEP-10 Challenge Endpoint
 * GET /api/auth/challenge?account=<public_key>
 *
 * Generates a SEP-10 challenge transaction for wallet authentication.
 * The client signs this challenge and submits it to /api/auth/verify
 * to receive a JWT token.
 */
export async function GET(request: NextRequest) {
  try {
    const accountPublicKey = request.nextUrl.searchParams.get('account');

    if (!accountPublicKey) {
      return authError('authorization_denied', "Missing 'account' parameter", 400);
    }
    if (!isValidWalletAddress(accountPublicKey)) {
      return authError('authorization_denied', 'Invalid public key format', 400);
    }

    const config = getSEP10Configuration();
    const { challenge, transactionHash, expiresAt } = buildSEP10Challenge(accountPublicKey, config);
    await storeSEP10Challenge(transactionHash, accountPublicKey, expiresAt);
    return NextResponse.json({ challenge, expiresAt }, { headers: PRIVATE_RESPONSE_HEADERS });
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return authError(error.code, error.message, error.code === 'configuration_error' ? 503 : 400);
    }
    console.error('SEP-10 challenge generation error:', error);
    return authError('exchange_failed', 'Failed to generate authentication challenge', 500);
  }
}

function authError(code: string, message: string, status: number) {
  return NextResponse.json(
    { code: isAuthErrorCode(code) ? code : 'exchange_failed', error: message },
    { status, headers: PRIVATE_RESPONSE_HEADERS }
  );
}
