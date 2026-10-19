import { Keypair, StrKey, WebAuth } from '@stellar/stellar-sdk';
import { NETWORK_PASSPHRASE } from '@/constants';
import { AuthenticationError } from './errors';

export const SEP10_CHALLENGE_TIMEOUT_SECONDS = 300;
export const SEP10_SESSION_TIMEOUT_SECONDS = 15 * 60;

export interface SEP10Configuration {
  serverKeypair: Keypair;
  homeDomain: string;
  webAuthDomain: string;
  jwtSecret: string;
}

export function getSEP10Configuration(): SEP10Configuration {
  const serverSecret = process.env.SEP10_SERVER_SECRET_KEY?.trim();
  const homeDomain = process.env.SEP10_HOME_DOMAIN?.trim();
  const jwtSecret = process.env.JWT_SECRET_KEY?.trim();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();

  if (!serverSecret || !homeDomain || !jwtSecret || !appUrl) {
    throw new AuthenticationError(
      'configuration_error',
      'SEP-10 requires SEP10_SERVER_SECRET_KEY, SEP10_HOME_DOMAIN, JWT_SECRET_KEY, and NEXT_PUBLIC_APP_URL'
    );
  }

  if (jwtSecret.length < 32) {
    throw new AuthenticationError(
      'configuration_error',
      'JWT_SECRET_KEY must contain at least 32 characters'
    );
  }

  let serverKeypair: Keypair;
  let webAuthDomain: string;
  try {
    serverKeypair = Keypair.fromSecret(serverSecret);
    webAuthDomain = new URL(appUrl).hostname;
  } catch {
    throw new AuthenticationError('configuration_error', 'SEP-10 configuration is invalid');
  }

  if (!webAuthDomain || !isValidDomain(homeDomain)) {
    throw new AuthenticationError('configuration_error', 'SEP-10 domains must be valid hostnames');
  }

  return { serverKeypair, homeDomain, webAuthDomain, jwtSecret };
}

export function isValidWalletAddress(account: unknown): account is string {
  return typeof account === 'string' && StrKey.isValidEd25519PublicKey(account);
}

export function buildSEP10Challenge(
  account: string,
  config: SEP10Configuration
): { challenge: string; transactionHash: string; expiresAt: string } {
  const challenge = WebAuth.buildChallengeTx(
    config.serverKeypair,
    account,
    config.homeDomain,
    SEP10_CHALLENGE_TIMEOUT_SECONDS,
    NETWORK_PASSPHRASE,
    config.webAuthDomain
  );
  const { tx } = WebAuth.readChallengeTx(
    challenge,
    config.serverKeypair.publicKey(),
    NETWORK_PASSPHRASE,
    config.homeDomain,
    config.webAuthDomain
  );

  return {
    challenge,
    transactionHash: tx.hash().toString('hex'),
    expiresAt: new Date(Number(tx.timeBounds?.maxTime) * 1000).toISOString(),
  };
}

export function verifySEP10Challenge(
  transaction: string,
  account: string,
  config: SEP10Configuration
): { transactionHash: string; expiresAt: string } {
  try {
    const challenge = WebAuth.readChallengeTx(
      transaction,
      config.serverKeypair.publicKey(),
      NETWORK_PASSPHRASE,
      config.homeDomain,
      config.webAuthDomain
    );

    if (challenge.clientAccountID !== account) {
      throw new AuthenticationError(
        'authorization_denied',
        'Signed challenge belongs to a different wallet'
      );
    }

    const signers = WebAuth.verifyChallengeTxSigners(
      transaction,
      config.serverKeypair.publicKey(),
      NETWORK_PASSPHRASE,
      [account],
      config.homeDomain,
      config.webAuthDomain
    );
    if (signers.length !== 1 || signers[0] !== account) {
      throw new AuthenticationError('authorization_denied', 'Wallet authorization was rejected');
    }

    return {
      transactionHash: challenge.tx.hash().toString('hex'),
      expiresAt: new Date(Number(challenge.tx.timeBounds?.maxTime) * 1000).toISOString(),
    };
  } catch (error) {
    if (error instanceof AuthenticationError) throw error;

    const message = error instanceof Error ? error.message : '';
    if (/expired/i.test(message)) {
      throw new AuthenticationError('challenge_expired', 'The authentication challenge expired');
    }
    if (/signer|signature|signed/i.test(message)) {
      throw new AuthenticationError('authorization_denied', 'Wallet authorization was rejected');
    }
    throw new AuthenticationError(
      'challenge_invalid',
      'The signed authentication challenge is invalid'
    );
  }
}

function isValidDomain(domain: string): boolean {
  if (domain.length > 253 || domain.includes('://') || domain.includes('/')) return false;
  const labels = domain.split('.');
  return (
    labels.length >= 2 &&
    labels.every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))
  );
}
