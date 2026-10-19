/**
 * Governance transaction confirmation reconciliation (#1064).
 *
 * Governance writes become user-visible proposals / tallies only after the
 * network has settled them. Local state must never decide that outcome: this
 * module derives one of four explicit states from an injected ledger reader
 * and a deterministic ledger window.
 *
 *   - `pending`    – the transaction is not in a ledger yet, but the window
 *                    during which it may still appear has not elapsed.
 *   - `confirmed`  – the ledger contains the transaction and it succeeded.
 *   - `failed`     – the ledger contains the transaction and it failed.
 *   - `timed-out`  – the transaction never appeared within the ledger window.
 *
 * The reader is injected (see `GovernanceLedgerReader`) so callers can supply
 * RPC-backed reads in production and fixed ledger fixtures in tests. Nothing
 * in this module fabricates a hash, a ledger height, or a verdict: an
 * unreachable reader always yields `pending`, never `confirmed`.
 */

/** Explicit confirmation states for a governance transaction. */
export type GovernanceConfirmationState = 'pending' | 'confirmed' | 'failed' | 'timed-out';

/** Minimal, authoritative shape of a settled ledger transaction. */
export interface GovernanceLedgerTransaction {
  /** Transaction hash. Must match the hash being reconciled. */
  hash: string;
  /** Ledger sequence that included the transaction. */
  ledger: number;
  /** Whether the transaction executed successfully in that ledger. */
  successful: boolean;
}

/** Authoritative ledger reads used by the reconciliation. */
export interface GovernanceLedgerReader {
  /** Look up a transaction by hash; `null` means it is not in a ledger yet. */
  getTransaction(hash: string): Promise<GovernanceLedgerTransaction | null>;
  /** Current ledger height, used to decide whether the window has elapsed. */
  getLatestLedger(): Promise<number>;
}

/** Human-readable reason for a non-settled state. */
export type GovernanceConfirmationReason =
  | 'not-found'
  | 'ledger-unreachable'
  | 'awaiting-ledger-window';

export interface GovernanceConfirmationReceipt {
  hash: string;
  state: GovernanceConfirmationState;
  /** Ledger that included the transaction, present only when settled. */
  ledger?: number;
  /** Why the transaction is still unresolved, present only when not settled. */
  reason?: GovernanceConfirmationReason;
}

export interface ReconcileGovernanceConfirmationOptions {
  /** Hash returned by the wallet / submission path. */
  hash: string;
  /** Ledger height at the moment the transaction was submitted. */
  submittedAtLedger: number;
  /** Number of ledgers to wait before declaring the transaction timed out. */
  maxLedgerWait: number;
  /** Authoritative ledger reader. */
  reader: GovernanceLedgerReader;
}

/** True once the network has returned a definitive verdict. */
export function isGovernanceConfirmationSettled(
  state: GovernanceConfirmationState
): state is 'confirmed' | 'failed' {
  return state === 'confirmed' || state === 'failed';
}

/**
 * Reconcile one submitted governance transaction against ledger truth.
 *
 * The function is side-effect free and deterministic for a given reader and
 * ledger window, which makes both the production call site and the test
 * fixtures straightforward to reason about.
 */
export async function reconcileGovernanceConfirmation({
  hash,
  submittedAtLedger,
  maxLedgerWait,
  reader,
}: ReconcileGovernanceConfirmationOptions): Promise<GovernanceConfirmationReceipt> {
  if (!hash) {
    throw new TypeError('Cannot reconcile a governance transaction without a hash.');
  }
  if (!Number.isInteger(submittedAtLedger) || submittedAtLedger < 0) {
    throw new TypeError('submittedAtLedger must be a non-negative integer ledger height.');
  }
  if (!Number.isInteger(maxLedgerWait) || maxLedgerWait <= 0) {
    throw new TypeError('maxLedgerWait must be a positive integer number of ledgers.');
  }

  let transaction: GovernanceLedgerTransaction | null;
  try {
    transaction = await reader.getTransaction(hash);
  } catch {
    // The network is not authoritative yet. Keep the transaction pending so a
    // later pass can reconcile it instead of assuming a verdict.
    return { hash, state: 'pending', reason: 'ledger-unreachable' };
  }

  if (transaction) {
    if (transaction.hash !== hash) {
      throw new Error(
        `Ledger reader returned transaction "${transaction.hash}" while reconciling "${hash}".`
      );
    }
    return {
      hash,
      state: transaction.successful ? 'confirmed' : 'failed',
      ledger: transaction.ledger,
    };
  }

  let latestLedger: number;
  try {
    latestLedger = await reader.getLatestLedger();
  } catch {
    return { hash, state: 'pending', reason: 'ledger-unreachable' };
  }

  if (!Number.isInteger(latestLedger) || latestLedger < submittedAtLedger) {
    throw new Error(
      `Ledger reader returned an invalid latest ledger "${String(latestLedger)}" for submission ledger ${submittedAtLedger}.`
    );
  }

  if (latestLedger - submittedAtLedger >= maxLedgerWait) {
    return { hash, state: 'timed-out', reason: 'not-found' };
  }

  return { hash, state: 'pending', reason: 'awaiting-ledger-window' };
}
