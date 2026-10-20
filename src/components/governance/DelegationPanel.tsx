'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  isValidStellarAddress,
  getDelegationInfo,
  getVotingPower,
  delegateVotingPower,
} from '@/utils/governance';
import { resolveFederatedAddress } from '@/utils/federation';
import { useWallet } from '@/context/WalletContext';
import { useTransaction } from '@/hooks/useTransaction';
import {
  Users,
  UserPlus,
  UserMinus,
  AlertCircle,
  Loader2,
  CheckCircle2,
  ShieldCheck,
} from 'lucide-react';

export const DelegationPanel: React.FC = () => {
  const { address, isConnected, signTx } = useWallet();
  const { execute, loading: txLoading, error: txError } = useTransaction();

  const [delegateAddress, setDelegateAddress] = useState('');
  const [resolvedDelegate, setResolvedDelegate] = useState('');
  const [resolving, setResolving] = useState(false);

  // Delegation state from contract authority
  const [currentDelegation, setCurrentDelegation] = useState<string | null>(null);
  const [ownBalance, setOwnBalance] = useState(1250);
  const [incomingDelegations, setIncomingDelegations] = useState(450);
  const [isLoading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [contractCycleDetected, setContractCycleDetected] = useState(false);
  const delegatingRef = useRef(false);

  const loadDelegationData = useCallback(async () => {
    if (!isConnected || !address) {
      setLoading(false);
      return;
    }

    await Promise.resolve();
    setLoading(true);
    setLoadError(null);
    try {
      const [delInfo, votingPower] = await Promise.all([
        getDelegationInfo(address).catch((err) => {
          console.warn('Failed to fetch delegation info:', err);
          return { delegatedTo: null, delegatedAmount: 0, incomingDelegations: 0 };
        }),
        getVotingPower(address).catch((err) => {
          console.warn('Failed to fetch voting power:', err);
          return 0;
        }),
      ]);

      if (delInfo) {
        if (!delegatingRef.current) {
          setCurrentDelegation(delInfo.delegatedTo);
        }
        setIncomingDelegations(delInfo.incomingDelegations);
        if (votingPower !== undefined) {
          setOwnBalance(Math.max(0, votingPower - delInfo.incomingDelegations));
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setLoadError(msg);
    } finally {
      setLoading(false);
    }
  }, [isConnected, address]);

  useEffect(() => {
    delegatingRef.current = false;
    let ignore = false;
    void (async () => {
      if (!ignore) {
        await loadDelegationData();
      }
    })();
    return () => {
      ignore = true;
    };
  }, [loadDelegationData]);

  const totalVotingWeight = ownBalance + incomingDelegations;

  const handleAddressChange = async (val: string) => {
    setDelegateAddress(val);
    setResolvedDelegate('');

    if (val.includes('*')) {
      setResolving(true);
      try {
        const resolved = await resolveFederatedAddress(val);
        setResolvedDelegate(resolved);
      } catch (e) {
        console.error('Federation resolution failed', e);
      } finally {
        setResolving(false);
      }
    } else if (isValidStellarAddress(val)) {
      setResolvedDelegate(val);
    }
  };

  useEffect(() => {
    if (!resolvedDelegate || !address || !isValidStellarAddress(resolvedDelegate)) {
      return;
    }
    let cancelled = false;
    getDelegationInfo(resolvedDelegate)
      .then((info) => {
        if (!cancelled) {
          setContractCycleDetected(info.delegatedTo === address);
        }
      })
      .catch(() => {
        if (!cancelled) setContractCycleDetected(false);
      });
    return () => {
      cancelled = true;
      setContractCycleDetected(false);
    };
  }, [resolvedDelegate, address]);

  const isCycleDetected = useMemo(() => {
    if (!resolvedDelegate) return false;
    if (address && resolvedDelegate === address) return true;
    if (contractCycleDetected) return true;
    const knownDelegatorsToMe = ['GABC123...', 'GDEF456...'];
    return knownDelegatorsToMe.includes(resolvedDelegate);
  }, [resolvedDelegate, address, contractCycleDetected]);

  const handleDelegate = async () => {
    if (!resolvedDelegate || isCycleDetected || !address) return;

    delegatingRef.current = true;
    const success = await execute(
      async () => delegateVotingPower(resolvedDelegate, address, signTx),
      `Delegating votes to ${resolvedDelegate}`
    );
    if (success) {
      setCurrentDelegation(resolvedDelegate);
      setDelegateAddress('');
      setResolvedDelegate('');
    } else {
      delegatingRef.current = false;
    }
  };

  const handleUndelegate = async () => {
    if (!address) return;
    delegatingRef.current = true;
    const success = await execute(
      async () => delegateVotingPower(null, address, signTx),
      'Removing vote delegation'
    );
    if (success) {
      setCurrentDelegation(null);
    } else {
      delegatingRef.current = false;
    }
  };

  if (!isConnected) {
    return (
      <div className="bg-gray-50 border border-gray-200 rounded-2xl p-8 text-center">
        <Users className="w-12 h-12 text-gray-300 mx-auto mb-4" />
        <h3 className="text-lg font-bold text-gray-900 mb-2">Vote Delegation</h3>
        <p className="text-gray-500 mb-6 text-sm">
          Connect your wallet to delegate your voting power.
        </p>
      </div>
    );
  }

  return (
    <div
      className="bg-white dark:bg-gray-800 rounded-3xl border border-gray-100 dark:border-gray-700 p-6 shadow-sm"
      aria-busy={isLoading}
    >
      {isLoading ? (
        <p role="status" className="sr-only">
          Loading your delegation status…
        </p>
      ) : null}
      {loadError ? (
        <div
          role="alert"
          className="mb-6 p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900 rounded-2xl text-red-700 dark:text-red-400 text-sm flex items-center justify-between"
        >
          <div className="flex items-center space-x-2">
            <AlertCircle className="w-5 h-5 flex-shrink-0" />
            <span>{loadError}</span>
          </div>
          <button
            onClick={() => void loadDelegationData()}
            className="text-xs font-bold underline hover:no-underline text-red-800 dark:text-red-300 ml-4"
          >
            Retry
          </button>
        </div>
      ) : null}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center space-x-2">
          <ShieldCheck className="w-6 h-6 text-indigo-600" />
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">Voting Power</h2>
        </div>
        <div className="text-right">
          <p className="text-xs uppercase tracking-wider text-gray-500 font-bold">Total Weight</p>
          <p className="text-2xl font-black text-indigo-600">{totalVotingWeight} ILN</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="bg-gray-50 dark:bg-gray-900/50 rounded-2xl p-4 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 mb-1">Your Balance</p>
          <p className="text-lg font-bold">{ownBalance} ILN</p>
        </div>
        <div className="bg-gray-50 dark:bg-gray-900/50 rounded-2xl p-4 border border-gray-100 dark:border-gray-700">
          <p className="text-xs text-gray-500 mb-1">Incoming Delegations</p>
          <p className="text-lg font-bold text-green-600">+{incomingDelegations} ILN</p>
        </div>
        <div className="bg-indigo-50 dark:bg-indigo-900/20 rounded-2xl p-4 border border-indigo-100 dark:border-indigo-800">
          <p className="text-xs text-indigo-600 dark:text-indigo-400 mb-1">Current Status</p>
          <p className="text-sm font-semibold truncate">
            {currentDelegation
              ? `Delegating to ${currentDelegation.slice(0, 6)}...`
              : 'Self-voting'}
          </p>
        </div>
      </div>

      <div className="space-y-6">
        <div>
          <label
            htmlFor="delegate-address"
            className="block text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2"
          >
            {currentDelegation ? 'Change Delegate' : 'Delegate Your Votes'}
          </label>
          <div className="flex space-x-2">
            <div className="relative flex-grow">
              <input
                id="delegate-address"
                type="text"
                placeholder="Stellar address (G...) or Federation (user*domain.org)"
                value={delegateAddress}
                onChange={(e) => handleAddressChange(e.target.value)}
                className="w-full rounded-xl border-gray-300 dark:border-gray-600 dark:bg-gray-700 shadow-sm focus:border-indigo-500 focus:ring-indigo-500 pl-4 pr-10"
              />
              {resolving && (
                <div
                  className="absolute right-3 top-2.5"
                  role="status"
                  aria-label="Resolving federation address"
                >
                  <Loader2 className="w-5 h-5 animate-spin text-gray-400" />
                </div>
              )}
            </div>
            <button
              onClick={handleDelegate}
              disabled={!resolvedDelegate || isCycleDetected || txLoading}
              className={`px-6 py-2 rounded-xl font-bold flex items-center space-x-2 transition-all ${
                !resolvedDelegate || isCycleDetected || txLoading
                  ? 'bg-gray-200 text-gray-400 cursor-not-allowed'
                  : 'bg-indigo-600 text-white hover:bg-indigo-700 shadow-md'
              }`}
            >
              <UserPlus className="w-4 h-4" />
              <span>Delegate</span>
            </button>
          </div>

          <div aria-live="polite">
            {resolvedDelegate && !isCycleDetected && (
              <p className="mt-2 text-xs text-green-600 flex items-center">
                <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                Ready to delegate to {resolvedDelegate.slice(0, 12)}...
                {resolvedDelegate.slice(-8)}
              </p>
            )}

            {isCycleDetected && (
              <div className="mt-3 bg-red-50 border border-red-100 rounded-lg p-3 flex items-start space-x-2 text-red-800">
                <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                <p className="text-xs font-medium">
                  You cannot delegate to an address that delegates back to you (Cycle detected).
                </p>
              </div>
            )}
          </div>
        </div>

        {currentDelegation && (
          <div className="pt-4 border-t border-gray-100 dark:border-gray-700">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <div className="bg-gray-100 dark:bg-gray-700 p-2 rounded-full">
                  <Users className="w-4 h-4 text-gray-600 dark:text-gray-400" />
                </div>
                <div>
                  <p className="text-xs text-gray-500 font-bold uppercase tracking-wider">
                    Delegating TO
                  </p>
                  <p className="text-sm font-mono">{currentDelegation}</p>
                </div>
              </div>
              <button
                onClick={handleUndelegate}
                disabled={txLoading}
                className="flex items-center space-x-1 text-sm font-bold text-red-600 hover:text-red-700 transition-colors"
              >
                <UserMinus className="w-4 h-4" />
                <span>Undelegate</span>
              </button>
            </div>
          </div>
        )}
      </div>

      {txError && (
        <div
          role="alert"
          className="mt-4 p-3 bg-red-50 border border-red-100 rounded-xl text-red-700 text-xs flex items-center"
        >
          <AlertCircle className="w-4 h-4 mr-2" />
          {txError}
        </div>
      )}
    </div>
  );
};
