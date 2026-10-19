'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useWallet } from '@/context/WalletContext';
import { useTransaction } from '@/hooks/useTransaction';
import { useBalances } from '@/hooks/useBalances';
import { useApprovedTokens } from '@/hooks/useApprovedTokens';
import {
  fetchProtocolParameters,
  createProposal,
  CreateProposalFormType,
  AcceptedToken,
  ProtocolParameters,
  isValidStellarAddress,
  lookupToken,
  simulateProposalEffect,
  ProposalSimulationResult,
} from '@/utils/governance';
import { CONTRACT_ERROR_MAP, parseContractError } from '@/lib/contract/errors';
import { Input } from '@/components/Input';
import { Button } from '@/components/Button';
import { Select } from '@/components/Select';
import { Textarea } from '@/components/Textarea';
import FieldTooltip from '@/components/FieldTooltip';
import GovernanceMockStatusBanner from '@/components/governance/GovernanceMockStatusBanner';
import { Loader2 } from 'lucide-react';

interface FormData {
  formType: CreateProposalFormType | '';
  title: string;
  description: string;
  newValueBps: string;
  tokenAddress: string;
  removeTokenAddress: string;
}

export default function NewGovernanceProposalPage() {
  const router = useRouter();
  const { address, isConnected } = useWallet();
  const { execute, loading: txLoading, signingModal } = useTransaction();
  const { tokens } = useApprovedTokens();
  const { balances, isLoading: balancesLoading } = useBalances(tokens);

  const [formData, setFormData] = useState<FormData>({
    formType: '',
    title: '',
    description: '',
    newValueBps: '',
    tokenAddress: '',
    removeTokenAddress: '',
  });
  const [protocolParams, setProtocolParams] = useState<ProtocolParameters | null>(null);
  const [loadingParams, setLoadingParams] = useState(true);
  const [formErrors, setFormErrors] = useState<Partial<Record<keyof FormData, string>>>({});
  const [resolvedToken, setResolvedToken] = useState<AcceptedToken | null>(null);
  const [tokenLookupError, setTokenLookupError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<ProposalSimulationResult | null>(null);
  const [loadingSimulation, setLoadingSimulation] = useState(false);

  const userILNBalance = useMemo(() => {
    // Assuming ILN token balance is available in balances array
    // For now, mocking as 1250 ILN from governance.ts mock
    return 1250;
  }, [balances]);

  useEffect(() => {
    const getParams = async () => {
      setLoadingParams(true);
      const params = await fetchProtocolParameters();
      setProtocolParams(params);
      setLoadingParams(false);
    };
    getParams();
  }, []);

  useEffect(() => {
    let cancelled = false;
    const debounceLookup = setTimeout(async () => {
      const addr = formData.tokenAddress.trim();
      if (formData.formType === 'AddToken' && addr) {
        try {
          const token = await lookupToken(addr);
          if (!cancelled) {
            setResolvedToken(token);
            setTokenLookupError(null);
          }
        } catch (e: unknown) {
          if (!cancelled) {
            const code = parseContractError(e);
            const msg = code
              ? CONTRACT_ERROR_MAP[code].message
              : e instanceof Error
                ? e.message
                : String(e);
            setTokenLookupError(msg);
            setResolvedToken(null);
          }
        }
      } else if (!cancelled) {
        setResolvedToken(null);
        setTokenLookupError(null);
      }
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(debounceLookup);
    };
  }, [formData.tokenAddress, formData.formType]);

  // Simulate proposal effect when form changes
  useEffect(() => {
    let cancelled = false;
    const debounceSimulation = setTimeout(async () => {
      // Only simulate if form has required fields
      if (!formData.formType || !formData.title) {
        setSimulationResult(null);
        return;
      }

      // Build payload for simulation
      const payload = {
        formType: formData.formType as CreateProposalFormType,
        title: formData.title,
        description: formData.description,
        newValueBps: formData.newValueBps ? parseInt(formData.newValueBps) : undefined,
        tokenAddress: formData.formType === 'AddToken' ? formData.tokenAddress : undefined,
        tokenName: resolvedToken?.name,
        removeTokenAddress:
          formData.formType === 'RemoveToken' ? formData.removeTokenAddress : undefined,
      };

      try {
        setLoadingSimulation(true);
        const result = await simulateProposalEffect(payload);
        if (!cancelled) {
          setSimulationResult(result);
        }
      } catch (err) {
        console.warn('Failed to simulate proposal effect:', err);
        if (!cancelled) {
          setSimulationResult(null);
        }
      } finally {
        if (!cancelled) {
          setLoadingSimulation(false);
        }
      }
    }, 800);

    return () => {
      cancelled = true;
      clearTimeout(debounceSimulation);
    };
  }, [formData, resolvedToken]);

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>
  ) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: value,
    }));
    // Clear error for the field being edited. The key has to be removed rather
    // than set to undefined: `isSubmitDisabled` counts Object.keys(formErrors),
    // so an undefined-valued key would keep Submit disabled forever.
    setFormErrors((prev) => {
      const next = { ...prev };
      delete next[name as keyof FormData];
      return next;
    });
  };

  const validateForm = useCallback(() => {
    const errors: Partial<Record<keyof FormData, string>> = {};
    if (!formData.formType) errors.formType = 'Action Type is required.';
    if (!formData.title.trim()) errors.title = 'Title is required.';
    if (!formData.description.trim()) errors.description = 'Description is required.';

    if (formData.formType === 'FeeRate' || formData.formType === 'MaxDiscountRate') {
      const value = parseInt(formData.newValueBps);
      if (isNaN(value) || value < 0 || value > 5000) {
        errors.newValueBps = 'Proposed Value must be between 0 and 5000 basis points.';
      }
    }

    if (formData.formType === 'AddToken') {
      if (!formData.tokenAddress.trim()) {
        errors.tokenAddress = 'Token address is required.';
      } else if (!isValidStellarAddress(formData.tokenAddress.trim())) {
        errors.tokenAddress = 'Invalid Stellar address format.';
      } else if (tokenLookupError) {
        errors.tokenAddress = tokenLookupError;
      }
    }

    if (formData.formType === 'RemoveToken') {
      if (!formData.removeTokenAddress.trim()) {
        errors.removeTokenAddress = 'Token address is required.';
      } else if (
        !protocolParams?.acceptedTokens.some((t) => t.address === formData.removeTokenAddress)
      ) {
        errors.removeTokenAddress = 'Token not found in accepted tokens.';
      }
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }, [formData, protocolParams, tokenLookupError]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isConnected || !address) {
      alert('Please connect your wallet.');
      return;
    }
    if (!protocolParams) {
      alert('Protocol parameters not loaded.');
      return;
    }
    if (!validateForm()) {
      return;
    }

    const ipfsHash = 'QmTg...mock'; // Mock IPFS CID generation

    try {
      const payload = {
        formType: formData.formType as CreateProposalFormType,
        title: formData.title,
        description:
          formData.description +
          `

IPFS Hash: ${ipfsHash}`,
        newValueBps: formData.newValueBps ? parseInt(formData.newValueBps) : undefined,
        tokenAddress: resolvedToken?.address,
        tokenName: resolvedToken?.name,
        removeTokenAddress: formData.removeTokenAddress,
      };

      // Routed through `execute` so the proposal is signed by the connected
      // wallet and its outcome reported through the shared transaction
      // handling: simulation errors surface before the signature prompt
      // (#1044) and a confirmation timeout is reported as an unknown outcome
      // rather than a failure (#1045). The previous identity `signTx` echoed
      // the XDR back unsigned, which a real network always rejects.
      const result = await execute(async (signTx) => createProposal(payload, address, signTx), {
        expectedAction: 'create_proposal',
        title: 'Submitting proposal…',
        pendingMessage: 'Waiting for wallet signature...',
        successTitle: 'Proposal submitted',
        successMessage: 'Your proposal is now on-chain.',
      });

      // `execute` has already surfaced any failure; only navigate on a
      // confirmed proposal.
      if (result) {
        router.push(`/governance/${result.proposalId}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      alert(`Failed to create proposal: ${msg}`);
    }
  };

  const isSubmitDisabled = useMemo(() => {
    const hasErrors = Object.keys(formErrors).length > 0;
    const isFormEmpty = !formData.formType || !formData.title || !formData.description;
    const insufficientBalance = protocolParams && userILNBalance < protocolParams.minProposalILN;
    return (
      hasErrors ||
      isFormEmpty ||
      insufficientBalance ||
      txLoading ||
      loadingParams ||
      balancesLoading
    );
  }, [
    formErrors,
    formData,
    protocolParams,
    userILNBalance,
    txLoading,
    loadingParams,
    balancesLoading,
  ]);

  const currentParameterValue = useMemo(() => {
    if (!protocolParams) return '';
    switch (formData.formType) {
      case 'FeeRate':
        return `${protocolParams.feeRateBps} (${protocolParams.feeRateBps / 100}%)`;
      case 'MaxDiscountRate':
        return `${protocolParams.maxDiscountRateBps} (${protocolParams.maxDiscountRateBps / 100}%)`;
      case 'AddToken':
      case 'RemoveToken':
        return `[${protocolParams.acceptedTokens.map((t) => t.symbol).join(', ')}]`;
      default:
        return '';
    }
  }, [formData.formType, protocolParams]);

  const proposedParameterValue = useMemo(() => {
    if (!protocolParams) return '';
    switch (formData.formType) {
      case 'FeeRate':
      case 'MaxDiscountRate': {
        const value = formData.newValueBps ? parseInt(formData.newValueBps) : undefined;
        return value !== undefined ? `${value} (${value / 100}%)` : '';
      }
      case 'AddToken': {
        if (!resolvedToken) return '';
        const existing = protocolParams.acceptedTokens.map((t) => t.symbol);
        return `[${[...existing, resolvedToken.symbol].join(', ')}]`;
      }
      case 'RemoveToken': {
        const tokenToRemove = protocolParams.acceptedTokens.find(
          (t) => t.address === formData.removeTokenAddress
        );
        if (!tokenToRemove) return '';
        const remaining = protocolParams.acceptedTokens
          .filter((t) => t.address !== formData.removeTokenAddress)
          .map((t) => t.symbol);
        return `[${remaining.join(', ')}]`;
      }
      default:
        return '';
    }
  }, [formData, protocolParams, resolvedToken]);

  if (loadingParams) {
    return (
      <div className="flex justify-center items-center h-screen">
        <Loader2 className="h-8 w-8 animate-spin" />
        <p className="ml-2">Loading protocol parameters...</p>
      </div>
    );
  }

  return (
    <main className="container mx-auto p-6 max-w-3xl">
      <GovernanceMockStatusBanner action="createProposal" />

      <h1 className="text-3xl font-bold mb-6">Create New Governance Proposal</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        <label className="block">
          <span className="text-zinc-700 dark:text-zinc-300">Action Type</span>
          <Select
            name="formType"
            value={formData.formType}
            onChange={handleChange}
            onBlur={validateForm}
            className="mt-1 block w-full"
            aria-describedby={formErrors.formType ? 'formType-error' : undefined}
            aria-invalid={Boolean(formErrors.formType)}
            required
          >
            <option value="">Select an action type</option>
            <option value="FeeRate">Update Fee Rate</option>
            <option value="MaxDiscountRate">Update Max Discount Rate</option>
            <option value="AddToken">Add Accepted Token</option>
            <option value="RemoveToken">Remove Accepted Token</option>
          </Select>
          {formErrors.formType && (
            <p id="formType-error" className="text-red-500 text-sm mt-1">
              {formErrors.formType}
            </p>
          )}
        </label>

        <label className="block">
          <span className="text-zinc-700 dark:text-zinc-300">Title</span>
          <Input
            type="text"
            name="title"
            value={formData.title}
            onChange={handleChange}
            onBlur={validateForm}
            className="mt-1 block w-full"
            placeholder="e.g., Reduce Base Discount Rate to 3.5%"
            aria-describedby={formErrors.title ? 'title-error' : undefined}
            aria-invalid={Boolean(formErrors.title)}
            required
          />
          {formErrors.title && (
            <p id="title-error" className="text-red-500 text-sm mt-1">
              {formErrors.title}
            </p>
          )}
        </label>

        <label className="block">
          <span className="text-zinc-700 dark:text-zinc-300">Description</span>
          <Textarea
            name="description"
            value={formData.description}
            onChange={handleChange}
            onBlur={validateForm}
            className="mt-1 block w-full"
            rows={5}
            placeholder="Provide a detailed explanation for your proposal..."
            aria-describedby={formErrors.description ? 'description-error' : undefined}
            aria-invalid={Boolean(formErrors.description)}
            required
          />
          {formErrors.description && (
            <p id="description-error" className="text-red-500 text-sm mt-1">
              {formErrors.description}
            </p>
          )}
        </label>

        {(formData.formType === 'FeeRate' || formData.formType === 'MaxDiscountRate') && (
          <label className="block">
            <span className="text-zinc-700 dark:text-zinc-300">Proposed Value (Basis Points)</span>
            <Input
              type="number"
              name="newValueBps"
              value={formData.newValueBps}
              onChange={handleChange}
              onBlur={validateForm}
              className="mt-1 block w-full"
              placeholder="e.g., 350 for 3.5% (0-5000)"
              min={0}
              max={5000}
              aria-describedby={formErrors.newValueBps ? 'newValueBps-error' : undefined}
              aria-invalid={Boolean(formErrors.newValueBps)}
              required
            />
            {formErrors.newValueBps && (
              <p id="newValueBps-error" className="text-red-500 text-sm mt-1">
                {formErrors.newValueBps}
              </p>
            )}
          </label>
        )}

        {formData.formType === 'AddToken' && (
          <label className="block">
            <span className="inline-flex items-center text-zinc-700 dark:text-zinc-300">
              Token Address (G...)
              <FieldTooltip content="ILN does not support fee-on-transfer tokens. The token must transfer the exact amount specified, with no fee deducted." />
            </span>
            <Input
              type="text"
              name="tokenAddress"
              value={formData.tokenAddress}
              onChange={handleChange}
              onBlur={validateForm}
              className="mt-1 block w-full"
              placeholder="e.g., G... (Stellar asset issuer address)"
              aria-describedby={formErrors.tokenAddress ? 'tokenAddress-error' : undefined}
              aria-invalid={Boolean(formErrors.tokenAddress)}
              required
            />
            {resolvedToken && (
              <p className="text-sm text-green-600 dark:text-green-400 mt-1">
                Resolved: {resolvedToken.name} ({resolvedToken.symbol})
              </p>
            )}
            {formErrors.tokenAddress && (
              <p id="tokenAddress-error" className="text-red-500 text-sm mt-1">
                {formErrors.tokenAddress}
              </p>
            )}
          </label>
        )}

        {formData.formType === 'RemoveToken' && (
          <label className="block">
            <span className="text-zinc-700 dark:text-zinc-300">Token to Remove</span>
            <Select
              name="removeTokenAddress"
              value={formData.removeTokenAddress}
              onChange={handleChange}
              onBlur={validateForm}
              className="mt-1 block w-full"
              aria-describedby={
                formErrors.removeTokenAddress ? 'removeTokenAddress-error' : undefined
              }
              aria-invalid={Boolean(formErrors.removeTokenAddress)}
              required
            >
              <option value="">Select a token to remove</option>
              {protocolParams?.acceptedTokens.map((token) => (
                <option key={token.address} value={token.address}>
                  {token.name} ({token.symbol})
                </option>
              ))}
            </Select>
            {formErrors.removeTokenAddress && (
              <p id="removeTokenAddress-error" className="text-red-500 text-sm mt-1">
                {formErrors.removeTokenAddress}
              </p>
            )}
          </label>
        )}

        {isConnected && protocolParams && userILNBalance < protocolParams.minProposalILN && (
          <div className="text-red-500 text-sm">
            Your current ILN balance ({userILNBalance}) is below the minimum required to submit a
            proposal ({protocolParams.minProposalILN}).
          </div>
        )}

        {formData.formType && formData.title && (
          <div
            className={`border p-4 rounded-lg ${simulationResult?.isContractVerified ? 'border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950' : 'border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-950'}`}
          >
            <div className="flex items-start justify-between mb-2">
              <h3
                className={`font-semibold ${simulationResult?.isContractVerified ? 'text-green-800 dark:text-green-200' : 'text-blue-800 dark:text-blue-200'}`}
              >
                Governance Simulation Preview
              </h3>
              {loadingSimulation && <Loader2 className="h-4 w-4 animate-spin" />}
            </div>

            {simulationResult && (
              <>
                <p
                  className={`text-sm mb-2 ${simulationResult.isContractVerified ? 'text-green-700 dark:text-green-300' : 'text-blue-700 dark:text-blue-300'}`}
                >
                  {simulationResult.estimatedEffect}
                </p>
                {!simulationResult.isContractVerified && (
                  <div className="mt-2 p-2 bg-yellow-50 dark:bg-yellow-950 border border-yellow-200 dark:border-yellow-800 rounded">
                    <p className="text-xs text-yellow-800 dark:text-yellow-200">
                      ⚠️ <span className="font-semibold">Estimated preview</span> — Not
                      contract-verified. Actual on-chain effect may differ due to protocol updates
                      between proposal creation and execution.
                    </p>
                  </div>
                )}
                {simulationResult.isContractVerified && (
                  <p className="text-xs text-green-700 dark:text-green-300 mt-2">
                    ✓ <span className="font-semibold">Contract-verified</span> simulation
                  </p>
                )}
                {simulationResult.warnings && simulationResult.warnings.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {simulationResult.warnings.map((warning, idx) => (
                      <p key={idx} className="text-xs text-amber-700 dark:text-amber-300">
                        ⚠️ {warning}
                      </p>
                    ))}
                  </div>
                )}
              </>
            )}

            {proposedParameterValue && (
              <p
                className={`text-sm mt-3 ${simulationResult?.isContractVerified ? 'text-green-700 dark:text-green-300' : 'text-blue-700 dark:text-blue-300'}`}
              >
                This proposal will change <span className="font-medium">[{formData.formType}]</span>{' '}
                from
                <span className="font-medium"> {currentParameterValue}</span> to
                <span className="font-medium"> {proposedParameterValue}</span>.
              </p>
            )}
          </div>
        )}

        <Button
          type="submit"
          className="w-full"
          disabled={isSubmitDisabled || !isConnected || !address}
        >
          {(txLoading || loadingParams || balancesLoading) && (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          )}
          Submit Proposal
        </Button>
      </form>
      {signingModal}
    </main>
  );
}
