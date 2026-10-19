'use client';

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Transaction } from '@stellar/stellar-sdk';
import { submitSignedTransaction } from '@/utils/soroban';
import { useToast } from '@/context/ToastContext';
import { useWallet } from '@/context/WalletContext';
import { notifyTxSuccess } from '@/utils/txEvents';
import { recordSigningAttempt } from '@/lib/signing-alert';
import {
  canRetryLifecycleStatus,
  classifyTransactionError,
  isInFlightLifecycleStatus,
  type TransactionLifecycleStatus,
} from '@/lib/transaction-lifecycle';
import {
  parseContractError,
  CONTRACT_ERROR_MAP,
  UNKNOWN_CONTRACT_ERROR,
} from '@/lib/contract/errors';
import { formatContractError } from '@/utils/contractErrorFormatter';
import { TransactionErrorToast } from '@/components/transaction/TransactionErrorToast';
import { GovernanceTxError, type GovernanceTxErrorCode } from '@/lib/governance-tx';
import { useTransactionPreview } from './useTransactionPreview';
import type { ExpectedTransactionAction } from '@/utils/transactionPattern';
import { NETWORK_NAME } from '@/constants';
import { normalizeWalletNetwork } from '@/utils/network';

type SignTxFn = (txXdr: string, expectedAction?: ExpectedTransactionAction) => Promise<string>;

type TransactionOperation<T> = (signTx: SignTxFn) => Promise<T>;

export interface ExecuteOptions {
  expectedAction?: ExpectedTransactionAction;
  idempotencyKey?: string;
  title?: string;
  pendingMessage?: string;
  successTitle?: string;
  successMessage?: string;
}

export interface UseTransactionResult {
  execute: <T = string>(
    txOrOperation: Transaction | TransactionOperation<T>,
    options?: string | ExecuteOptions
  ) => Promise<T | null>;
  loading: boolean;
  error: string | null;
  success: boolean;
  isSigning: boolean;
  /** Typed lifecycle state; only RPC settlement moves it to confirmed/failed (#1142). */
  lifecycleStatus: TransactionLifecycleStatus;
  /** Settlement hash when the operation resolved to one. */
  txHash: string | null;
  signingModal: ReactNode;
}

/**
 * Toast titles per governance failure code (#1044, #1045).
 *
 * Each one names what actually happened, so "we stopped waiting" never reads
 * as "it failed" and a pre-signing rejection never reads as an on-chain one.
 */
const GOVERNANCE_ERROR_TITLES: Partial<Record<GovernanceTxErrorCode, string>> = {
  CONTRACT_NOT_CONFIGURED: 'Governance not available',
  ENTRYPOINT_MISSING: 'Governance not available',
  SOURCE_ACCOUNT_MISSING: 'Wallet account unavailable',
  SIMULATION_UNAUTHORIZED: 'Not authorized',
  SIMULATION_INSUFFICIENT_RESOURCES: 'Transaction too large',
  SIMULATION_ARCHIVED_STATE: 'Proposal state archived',
  PROPOSAL_NOT_FOUND: 'Proposal not found',
  SIMULATION_CONTRACT_ERROR: 'Action rejected by contract',
  SIMULATION_FAILED: 'Could not simulate action',
  USER_REJECTED: 'Transaction cancelled',
  SUBMISSION_REJECTED: 'Submission rejected',
  TX_FAILED: 'Transaction failed on-chain',
  TX_TIMEOUT: 'Still confirming — outcome unknown',
};

function isWalletRejection(message: string) {
  return /reject|cancel|denied|declined|user rejected|user declined/i.test(message);
}

function getOptions(options?: string | ExecuteOptions): ExecuteOptions {
  if (!options) return {};
  return typeof options === 'string' ? { title: options } : options;
}

export function useTransaction(): UseTransactionResult {
  const { signTx, isConnected, address, networkMismatch, walletNetwork } = useWallet();
  const { addToast, updateToast } = useToast();
  const queryClient = useQueryClient();
  const { previewModal, requestPreview } = useTransactionPreview();

  const [loading, setLoading] = useState(false);
  const [isSigning, setIsSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [lifecycleStatus, setLifecycleStatus] = useState<TransactionLifecycleStatus>('unsigned');
  const [txHash, setTxHash] = useState<string | null>(null);
  // Synchronous in-flight guard: a second execute while one is running is
  // ignored so retry/reconnect paths can never duplicate a submission (#1143).
  const inFlightRef = useRef(false);
  const lifecycleRef = useRef<TransactionLifecycleStatus>('unsigned');

  /** Advance only forward along unsigned → signed → submitted → confirming. */
  const advanceLifecycle = useCallback((next: TransactionLifecycleStatus) => {
    const rank: Record<TransactionLifecycleStatus, number> = {
      unsigned: 0,
      signed: 1,
      submitted: 2,
      confirming: 3,
      confirmed: 4,
      failed: -1,
      cancelled: -1,
    };
    const current = lifecycleRef.current;
    if (next === 'failed' || next === 'cancelled' || next === 'confirmed') {
      lifecycleRef.current = next;
      setLifecycleStatus(next);
      return;
    }
    if (rank[next] > rank[current]) {
      lifecycleRef.current = next;
      setLifecycleStatus(next);
    }
  }, []);

  const setLifecycle = useCallback((next: TransactionLifecycleStatus) => {
    lifecycleRef.current = next;
    setLifecycleStatus(next);
  }, []);

  const activeToastIdRef = useRef<string | null>(null);
  const inFlightKeysRef = useRef<Set<string>>(new Set());
  const confirmedOperationsRef = useRef<Map<string, { result: any; timestamp: number }>>(new Map());
  const executeRef = useRef<
    | ((
        txOrOperation: Transaction | TransactionOperation<any>,
        options?: string | ExecuteOptions
      ) => Promise<any>)
    | null
  >(null);

  // Disconnect recovery: abort in-flight state safely if wallet disconnects while executing (#1147)
  useEffect(() => {
    if (!isConnected && (loading || isSigning)) {
      setLoading(false);
      setIsSigning(false);
      const msg =
        'Wallet disconnected during transaction. Please reconnect your wallet to continue.';
      setError(msg);
      if (activeToastIdRef.current) {
        updateToast(activeToastIdRef.current, {
          type: 'error',
          title: 'Transaction Interrupted',
          message: msg,
        });
        activeToastIdRef.current = null;
      }
      inFlightKeysRef.current.clear();
    }
  }, [isConnected, loading, isSigning, updateToast]);

  const signTxWithUi: SignTxFn = useCallback(
    async (txXdr: string, expectedAction?: ExpectedTransactionAction) => {
      try {
        await requestPreview(txXdr, expectedAction);
      } catch (err: any) {
        const message = err?.message || String(err || 'Transaction cancelled');
        if (isWalletRejection(message)) {
          throw new Error('Transaction cancelled');
        }
        throw err;
      }

      setIsSigning(true);
      try {
        return await signTx(txXdr);
      } catch (err: any) {
        const message = err?.message || String(err || 'Transaction cancelled');
        if (isWalletRejection(message)) {
          throw new Error('Transaction cancelled');
        }
        throw err;
      } finally {
        setIsSigning(false);
      }
    },
    [signTx, requestPreview]
  );

  const execute = useCallback(
    async <T = string,>(
      txOrOperation: Transaction | TransactionOperation<T>,
      options?: string | ExecuteOptions
    ): Promise<T | null> => {
      if (!isConnected || !address) {
        setError('Wallet not connected');
        return null;
      }

      // Ignore a second execute while one is in flight: re-submitting would
      // duplicate the on-chain action (#1143).
      if (inFlightRef.current || isInFlightLifecycleStatus(lifecycleRef.current)) {
        return null;
      }

      // Wrong-network protection: block signing and explain required network before any mutation (#1145)
      if (networkMismatch) {
        const currentNetwork = walletNetwork ? normalizeWalletNetwork(walletNetwork) : 'unknown';
        const msg = `Wrong network detected (${currentNetwork}). Transactions require ${NETWORK_NAME}. Please switch your wallet network to ${NETWORK_NAME} before proceeding.`;
        setError(msg);
        addToast({
          type: 'error',
          title: 'Wrong Network Blocked',
          message: msg,
        });
        return null;
      }

      const resolvedOptions = getOptions(options);
      const title = resolvedOptions.title ?? 'Processing transaction...';
      const pendingMessage = resolvedOptions.pendingMessage ?? 'Waiting for wallet signature...';
      const successTitle = resolvedOptions.successTitle ?? 'Transaction complete';
      const successMessage = resolvedOptions.successMessage ?? 'Your transaction was confirmed.';

      inFlightRef.current = true;
      // Transaction retry idempotency (#1146): deduplicate concurrent or recent duplicate operations
      const opKey =
        resolvedOptions.idempotencyKey ||
        (resolvedOptions.expectedAction
          ? `${resolvedOptions.expectedAction}:${resolvedOptions.title || ''}`
          : resolvedOptions.title || 'generic-operation');

      // If identical operation is already in flight, prevent duplicate signing/submission
      if (inFlightKeysRef.current.has(opKey)) {
        inFlightRef.current = false;
        return null;
      }

      // If already confirmed within 5 minutes, return confirmed result idempotently
      const cached = confirmedOperationsRef.current.get(opKey);
      if (cached && Date.now() - cached.timestamp < 5 * 60 * 1000) {
        inFlightRef.current = false;
        return cached.result as T;
      }

      inFlightKeysRef.current.add(opKey);
      setLoading(true);
      setError(null);
      setSuccess(false);
      setTxHash(null);
      setLifecycle('unsigned');

      const toastId = addToast({
        type: 'pending',
        title,
        message: pendingMessage,
      });
      activeToastIdRef.current = toastId;

      const operation: TransactionOperation<T> =
        typeof txOrOperation === 'function'
          ? txOrOperation
          : async (signTx) => {
              const { txHash: settledHash } = await submitSignedTransaction({
                tx: txOrOperation,
                signTx,
                pendingLabel: resolvedOptions.expectedAction ?? 'transaction',
                onStatus: (stage) => advanceLifecycle(stage),
              });
              return settledHash as unknown as T;
            };

      const retry = async () => {
        // Only a failed transaction may be retried; cancelled / in-flight /
        // confirmed must never re-submit (#1142).
        if (!canRetryLifecycleStatus(lifecycleRef.current)) return;
        // Clear in-flight lock for idempotency key to allow clean retry (#1146)
        inFlightKeysRef.current.delete(opKey);
        if (executeRef.current) {
          await executeRef.current(txOrOperation, options);
        }
      };

      try {
        const signTxForOperation: SignTxFn = async (txXdr) => {
          const signed = await signTxWithUi(txXdr, resolvedOptions.expectedAction);
          advanceLifecycle('signed');
          return signed;
        };
        // Function operations manage their own submission; mark confirmation
        // while awaiting so the lifecycle reflects network truth (#1142).
        if (typeof txOrOperation === 'function') {
          advanceLifecycle('confirming');
        }
        const result = await operation(signTxForOperation);
        if (typeof result === 'string') setTxHash(result);

        // Record confirmed result in idempotency cache
        confirmedOperationsRef.current.set(opKey, {
          result,
          timestamp: Date.now(),
        });

        // Surface transaction explorer links from confirmed IDs (#1148)
        let txHash: string | undefined;
        if (typeof result === 'string') {
          txHash = result;
        } else if (result && typeof result === 'object' && 'txHash' in result) {
          const rawHash = (result as { txHash?: unknown }).txHash;
          if (typeof rawHash === 'string') {
            txHash = rawHash;
          }
        }

        setSuccess(true);
        setLifecycle('confirmed');
        recordSigningAttempt({
          flow: resolvedOptions.expectedAction ?? 'transaction',
          success: true,
        });

        updateToast(toastId, {
          type: 'success',
          title: successTitle,
          message: successMessage,
          txHash,
        });

        activeToastIdRef.current = null;
        queryClient.invalidateQueries();
        notifyTxSuccess();
        return result;
      } catch (err: any) {
        const classification = classifyTransactionError(err);

        // Declined signature / closed wallet: keep every piece of local UI
        // state unchanged — no error escalation, no invalidation, no success
        // signal, and no retry that could duplicate the action (#1144).
        if (classification.kind === 'cancelled') {
          setSuccess(false);
          setError(null);
          setLifecycle('cancelled');
          recordSigningAttempt({
            flow: resolvedOptions.expectedAction ?? 'transaction',
            success: false,
            errorCode: 'USER_REJECTED',
            errorMessage: classification.message,
          });
          updateToast(toastId, {
            type: 'info',
            title: 'Transaction cancelled',
            message: 'Signature declined in wallet. No changes were made.',
          });
          activeToastIdRef.current = null;
          return null;
        }

        // Wrong network: block signing safely until the wallet switches.
        // No retry is offered — retrying on the wrong network cannot settle
        // and risks a duplicate once the network changes (#1144).
        if (classification.kind === 'wrong-network') {
          setSuccess(false);
          setError(classification.message);
          setLifecycle('failed');
          recordSigningAttempt({
            flow: resolvedOptions.expectedAction ?? 'transaction',
            success: false,
            errorCode: 'NETWORK_MISMATCH',
            errorMessage: classification.message,
          });
          updateToast(toastId, {
            type: 'error',
            title: 'Wrong network',
            message: `${classification.message}. Switch your wallet to ${resolvedOptions.expectedAction ? 'the required' : 'the correct'} network, then try again. No changes were made.`,
          });
          activeToastIdRef.current = null;
          return null;
        }

        // Governance writes carry their own classification and remediation
        // (#1044, #1045), so they bypass the generic contract-error mapping.
        // The three outcomes stay visibly distinct: a bounded-confirmation
        // timeout is reported as an *unknown* outcome with no Retry action,
        // because the transaction may still confirm and re-submitting could
        // apply the vote twice.
        if (err instanceof GovernanceTxError) {
          const isTimeout = err.code === 'TX_TIMEOUT';
          setError(err.remediation);
          setSuccess(false);
          setLifecycle(isTimeout ? 'confirming' : 'failed');
          setTxHash(err.txHash ?? null);

          recordSigningAttempt({
            flow: resolvedOptions.expectedAction ?? 'governance',
            success: false,
            errorCode: err.code,
            errorMessage: err.message,
          });

          updateToast(toastId, {
            type: isTimeout ? 'warning' : 'error',
            title: GOVERNANCE_ERROR_TITLES[err.code] ?? 'Governance action failed',
            message: (
              <TransactionErrorToast
                message={err.message}
                remediation={err.remediation}
                technicalDetails={err.diagnostics}
              />
            ),
            txHash: err.txHash,
            // Only offer a retry when the action provably did not land.
            action: err.resubmitSafe ? { label: 'Retry', onClick: retry } : undefined,
          });

          activeToastIdRef.current = null;
          return null;
        }

        const formattedErr = formatContractError(err);
        const message = formattedErr.message;
        const isRejected = formattedErr.code === 'USER_REJECTED' || isWalletRejection(message);
        setError(formattedErr.userFriendlyMessage);
        setSuccess(false);
        setLifecycle(isRejected ? 'cancelled' : 'failed');

        recordSigningAttempt({
          flow: resolvedOptions.expectedAction ?? 'transaction',
          success: false,
          errorCode: isRejected ? 'USER_REJECTED' : formattedErr.code,
          errorMessage: message,
        });

        let title = 'Transaction failed';
        let toastMessage: React.ReactNode = `${message}. Please try again or contact support if the issue persists.`;

        if (isRejected) {
          title = 'Transaction cancelled';
          toastMessage = 'Transaction cancelled';
        } else {
          const code = parseContractError(err);
          const errorInfo = code ? CONTRACT_ERROR_MAP[code] : UNKNOWN_CONTRACT_ERROR;

          title = errorInfo.title;

          const hasTechnicalDetails =
            !!code ||
            (message && message !== 'Transaction failed.' && message !== errorInfo.message);
          const technicalDetails = hasTechnicalDetails
            ? code
              ? `${code}\n${message}`
              : message
            : undefined;

          toastMessage = (
            <TransactionErrorToast
              message={errorInfo.message}
              remediation={errorInfo.remediation}
              technicalDetails={technicalDetails}
            />
          );
        }

        updateToast(toastId, {
          type: 'error',
          title,
          message: toastMessage,
          action: isRejected
            ? undefined
            : {
                label: 'Retry',
                onClick: retry,
              },
        });

        activeToastIdRef.current = null;
        return null;
      } finally {
        inFlightRef.current = false;
        inFlightKeysRef.current.delete(opKey);
        setLoading(false);
        setIsSigning(false);
      }
    },
    [
      address,
      addToast,
      advanceLifecycle,
      isConnected,
      networkMismatch,
      walletNetwork,
      queryClient,
      setLifecycle,
      signTxWithUi,
      updateToast,
    ]
  );
  useEffect(() => {
    executeRef.current = execute;
  }, [execute]);

  const signingModal = useMemo(() => {
    if (!isSigning) return null;
    return (
      <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-md rounded-[32px] border border-surface-variant bg-surface-container-lowest p-8 text-center shadow-2xl">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-primary/10 text-primary">
            <span className="material-symbols-outlined animate-spin text-3xl">sync</span>
          </div>
          <h2 className="text-xl font-bold">Waiting for wallet signature...</h2>
          <p className="mt-3 text-sm text-on-surface-variant">
            Please approve the transaction in your wallet to continue.
          </p>
        </div>
      </div>
    );
  }, [isSigning]);

  return {
    execute,
    loading,
    error,
    success,
    isSigning,
    lifecycleStatus,
    txHash,
    signingModal: (
      <>
        {previewModal}
        {signingModal}
      </>
    ),
  };
}
