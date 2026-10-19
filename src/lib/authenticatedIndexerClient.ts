/**
 * Authenticated indexer request client.
 *
 * Wraps the base indexer fetch boundary with SEP-10 session credentials,
 * forwarding the Bearer token on every authoritative API call and handling
 * 401 responses by clearing the expired session and surfacing a typed error.
 *
 * #1077: Add authenticated indexer request client
 */

import {
  fetchIndexer,
  IndexerClientError,
  type IndexerFetchOptions,
  type IndexerRequestOptions,
  type RawInvoiceEvent,
  validateInvoiceEvents,
} from '@/lib/indexer-client';
import { sep10Session, type Sep10Session } from '@/lib/sep10Session';

export type SessionProvider = () => Sep10Session | null;

export interface AuthenticatedIndexerOptions extends IndexerRequestOptions {
  /** Override which session to use. Defaults to the global sep10Session singleton. */
  sessionProvider?: SessionProvider;
  /**
   * Called when the server responds with 401. Use this to trigger
   * reauthentication in the UI rather than swallowing the error.
   */
  onUnauthorized?: () => void;
}

/**
 * Authenticated version of fetchIndexer.
 *
 * Attaches a `Authorization: Bearer <token>` header when a valid SEP-10
 * session exists. On a 401 response from the server, it clears the current
 * session (the token is no longer accepted) and re-throws the error so
 * callers can prompt reauthentication.
 */
export async function fetchIndexerAuthenticated<T = unknown>(
  path: string,
  options: IndexerFetchOptions<T> & AuthenticatedIndexerOptions = {}
): Promise<T> {
  const { sessionProvider, onUnauthorized, ...fetchOptions } = options;

  const session = sessionProvider ? sessionProvider() : sep10Session.getSession();
  const authHeader: Record<string, string> = {};

  if (session?.token) {
    authHeader['Authorization'] = `Bearer ${session.token}`;
  }

  try {
    return await fetchIndexer<T>(path, {
      ...fetchOptions,
      headers: {
        ...fetchOptions.headers,
        ...authHeader,
      },
    });
  } catch (err) {
    if (
      err instanceof IndexerClientError &&
      (err.type === 'unauthorized' || err.status === 401)
    ) {
      // The session token was rejected — clear it so the UI can re-prompt
      sep10Session.clearSession('token_expired');
      onUnauthorized?.();
    }
    throw err;
  }
}

/**
 * Fetch authenticated invoice events. Falls back to unauthenticated if no
 * session is present (public endpoints still work; private ones will 401).
 */
export async function fetchAuthenticatedInvoiceEvents(
  invoiceId: bigint | string,
  options: AuthenticatedIndexerOptions = {}
): Promise<RawInvoiceEvent[]> {
  return fetchIndexerAuthenticated<RawInvoiceEvent[]>(
    `/invoice/${invoiceId}/events`,
    {
      ...options,
      validate: validateInvoiceEvents,
    }
  );
}

/**
 * Fetch any resource that requires a valid SEP-10 session.
 * Throws `IndexerClientError { type: 'unauthorized' }` if the session is
 * missing or the server rejects it.
 */
export async function fetchPrivateIndexerResource<T = unknown>(
  path: string,
  options: AuthenticatedIndexerOptions & IndexerFetchOptions<T> = {}
): Promise<T> {
  const session = options.sessionProvider
    ? options.sessionProvider()
    : sep10Session.getSession();

  if (!session) {
    throw new IndexerClientError({
      type: 'unauthorized',
      message: 'An authenticated session is required for this request. Please sign in.',
      status: 401,
      boundaryStatus: 'unauthorized',
      isRetryable: false,
    });
  }

  return fetchIndexerAuthenticated<T>(path, options);
}
