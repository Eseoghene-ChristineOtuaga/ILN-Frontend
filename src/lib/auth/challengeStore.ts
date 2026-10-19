import { createClient } from '@supabase/supabase-js';
import { AuthenticationError } from './errors';

interface ChallengeRecord {
  challenge_hash: string;
  account: string;
  expires_at: string;
}

function getChallengeStore() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !serviceRoleKey) {
    throw new AuthenticationError(
      'configuration_error',
      'SEP-10 challenge persistence requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY'
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function storeSEP10Challenge(
  challengeHash: string,
  account: string,
  expiresAt: string
): Promise<void> {
  const client = getChallengeStore();
  const { error: cleanupError } = await client
    .from('sep10_auth_challenges')
    .delete()
    .lt('expires_at', new Date().toISOString());
  if (cleanupError) {
    throw new Error(`Failed to clean expired SEP-10 challenges: ${cleanupError.message}`);
  }

  const record: ChallengeRecord = {
    challenge_hash: challengeHash,
    account,
    expires_at: expiresAt,
  };
  const { error } = await client.from('sep10_auth_challenges').insert(record);
  if (error) {
    throw new Error(`Failed to store SEP-10 challenge: ${error.message}`);
  }
}

export async function consumeSEP10Challenge(
  challengeHash: string,
  account: string
): Promise<'consumed' | 'expired' | 'replayed'> {
  const client = getChallengeStore();
  const now = new Date().toISOString();
  const { data, error } = await client
    .from('sep10_auth_challenges')
    .delete()
    .eq('challenge_hash', challengeHash)
    .eq('account', account)
    .gt('expires_at', now)
    .select('challenge_hash');
  if (error) {
    throw new Error(`Failed to consume SEP-10 challenge: ${error.message}`);
  }
  if (data.length > 0) return 'consumed';

  const { data: record, error: lookupError } = await client
    .from('sep10_auth_challenges')
    .select('expires_at')
    .eq('challenge_hash', challengeHash)
    .eq('account', account)
    .maybeSingle();
  if (lookupError) {
    throw new Error(`Failed to inspect SEP-10 challenge: ${lookupError.message}`);
  }

  return record ? 'expired' : 'replayed';
}
