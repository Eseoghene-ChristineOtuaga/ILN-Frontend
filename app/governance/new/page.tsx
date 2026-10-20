'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useWallet } from '@/context/WalletContext';
import {
  fetchProtocolParameters,
  fetchProposerBalance,
  createProposal,
  CreateProposalFormType,
  CreateProposalPayload,
  CreateProposalStage,
  AcceptedToken,
  ProtocolParameters,
  lookupToken,
  simulateProposalEffect,
  ProposalSimulationResult,
  validateProposalPayload,
  issuesByField,
  toValidationContext,
  requiredProposerBalance,
  ProposalValidationError,
  CreateProposalError,
  ChainParametersError,
} from '@/utils/governance';
import { useInvalidateGovernanceQueries } from '@/hooks/queries';
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

type FormErrors = Partial<Record<keyof FormData | 'submit', string>>;

/** Fields whose checks need chain parameters (ranges, current value, allowlist). */
const CHAIN_DEPENDENT_FIELDS = new Set<keyof FormData>([
  'newValueBps',
  'tokenAddress',
  'removeTokenAddress',
]);

const STAGE_LABELS: Record<CreateProposalStage, string> = {
  validating: 'Validating proposal…',
  building: 'Building transaction…',
  simulating: 'Simulating against the governance contract…',
  awaiting_signature: 'Waiting for your wallet signature…',
  submitting: 'Submitting transaction…',
  confirming: 'Waiting for network confirmation…',
  confirmed: 'Proposal confirmed on-chain.',
};

/** Format a base-unit amount as a decimal token string without float rounding. */
function formatTokenAmount(amount: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = amount / scale;
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction ? `${whole.toLocaleString()}.${fraction}` : whole.toLocaleString();
}

function formatBps(value: number): string {
  return `${value} (${value / 100}%)`;
}

function describeSubmitError(error: unknown): string {
  if (error instanceof CreateProposalError) {
    switch (error.code) {
      case 'USER_REJECTED':
        return 'Signature declined in your wallet. No proposal was created.';
      case 'CONFIRMATION_TIMEOUT':
        return `Transaction ${error.details.txHash ?? ''} was submitted but is not confirmed yet. Check its status before submitting again.`;
      case 'TRANSACTION_FAILED':
        return `The proposal transaction failed on-chain${
          error.details.txHash ? ` (${error.details.txHash})` : ''
        }. No proposal was created.`;
      default:
        return error.message.replace(/^[A-Z_]+: /, '');
    }
  }
  if (error instanceof ChainParametersError) {
    return 'Protocol parameters could not be read from the network. Try again shortly.';
  }
  const code = parseContractError(error);
  if (code) return CONTRACT_ERROR_MAP[code].message;
  return error instanceof Error ? error.message : String(error);
}

export default function NewGovernanceProposalPage() {
  const router = useRouter();
  const { address, isConnected } = useWallet();
  const { execute, loading: txLoading, signingModal } = useTransaction();
  const { tokens } = useApprovedTokens();
  const { balances, isLoading: balancesLoading } = useBalances(tokens);
  const { address, isConnected, signTx } = useWallet();
  const { address, isConnected, signTx, walletNetwork } = useWallet();
  const invalidateGovernanceQueries = useInvalidateGovernanceQueries();

  const [formData, setFormData] = useState<FormData>({
    formType: '',
    title: '',
    description: '',
    newValueBps: '',
    tokenAddress: '',
    removeTokenAddress: '',
  });
  const [protocolParams, setProtocolParams] = useState<ProtocolParameters | null>(null);
  const [paramsError, setParamsError] = useState<string | null>(null);
  const [loadingParams, setLoadingParams] = useState(true);
  const [balanceState, setBalanceState] = useState<{
    address: string;
    value: bigint | null;
    error: string | null;
  } | null>(null);
  const [formErrors, setFormErrors] = useState<FormErrors>({});
  const [resolvedToken, setResolvedToken] = useState<AcceptedToken | null>(null);
  const [tokenLookupError, setTokenLookupError] = useState<string | null>(null);
  const [simulationResult, setSimulationResult] = useState<ProposalSimulationResult | null>(null);
  const [loadingSimulation, setLoadingSimulation] = useState(false);
  const [stage, setStage] = useState<CreateProposalStage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const isSubmittingRef = useRef(false);

  // Incremented by the Retry buttons to re-run the reads below.
  const [paramsAttempt, setParamsAttempt] = useState(0);
  const [balanceAttempt, setBalanceAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const readParams = async () => {
      try {
        const params = await fetchProtocolParameters();
        if (cancelled) return;
        setProtocolParams(params);
        setParamsError(null);
      } catch (e: unknown) {
        if (cancelled) return;
        setProtocolParams(null);
        setParamsError(
          e instanceof ChainParametersError
            ? `Protocol parameters could not be read from the network (${e.failed.join(', ')}).`
            : 'Protocol parameters could not be read from the network.'
        );
      } finally {
        if (!cancelled) setLoadingParams(false);
      }
    };
    void readParams();
    return () => {
      cancelled = true;
    };
  }, [paramsAttempt]);

  const retryParams = () => {
    setLoadingParams(true);
    setParamsError(null);
    setParamsAttempt((n) => n + 1);
  };

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    const readBalance = async () => {
      try {
        const value = await fetchProposerBalance(address);
        if (!cancelled) setBalanceState({ address, value, error: null });
      } catch (e: unknown) {
        if (!cancelled) {
          setBalanceState({
            address,
            value: null,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    };
    void readBalance();
    return () => {
      cancelled = true;
    };
  }, [address, balanceAttempt]);

  // A balance read for a previous wallet address is never shown for the current one.
  const currentBalance = address && balanceState?.address === address ? balanceState : null;
  const balance = currentBalance?.value ?? null;
  const balanceError = currentBalance?.error ?? null;

  useEffect(() => {
    let cancelled = false;
    const debounceLookup = setTimeout(async () => {
      const addr = formData.tokenAddress.trim();
      if (formData.formType === 'AddToken' && addr) {
        try {
          const token = await lookupToken(addr, protocolParams?.acceptedTokens);
          if (!cancelled) {
            setResolvedToken(token);
            setTokenLookupError(null);
          }
        } catch (e: unknown) {
          if (!cancelled) {
            setTokenLookupError(describeSubmitError(e));
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
  }, [formData.tokenAddress, formData.formType, protocolParams]);

  const payload = useMemo<CreateProposalPayload | null>(() => {
    if (!formData.formType) return null;
    const trimmedValue = formData.newValueBps.trim();
    return {
      formType: formData.formType,
      title: formData.title,
      description: formData.description,
      newValueBps: trimmedValue === '' ? undefined : Number(trimmedValue),
      tokenAddress: formData.formType === 'AddToken' ? formData.tokenAddress.trim() : undefined,
      tokenName: resolvedToken?.symbol,
      tokenDecimals: resolvedToken?.decimals,
      removeTokenAddress:
        formData.formType === 'RemoveToken' ? formData.removeTokenAddress : undefined,
    };
  }, [formData, resolvedToken]);

  // Simulate proposal effect when form changes
  useEffect(() => {
    let cancelled = false;
    const debounceSimulation = setTimeout(async () => {
      if (!payload || !formData.title) {
        setSimulationResult(null);
        return;
      }
      try {
        setLoadingSimulation(true);
        const result = await simulateProposalEffect(payload);
        if (!cancelled) setSimulationResult(result);
      } catch (err) {
        console.warn('Failed to simulate proposal effect:', err);
        if (!cancelled) setSimulationResult(null);
      } finally {
        if (!cancelled) setLoadingSimulation(false);
      }
    }, 800);

    return () => {
      cancelled = true;
      clearTimeout(debounceSimulation);
    };
  }, [payload, formData.title]);

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
      delete next.submit;
      return next;
    });
  };

  /**
   * Validate against the contract schema (#1056) with chain parameters
   * (#1054). Without parameters only the text fields can be checked; the
   * chain-dependent fields are left for when parameters load.
   */
  const validateForm = useCallback(() => {
    const errors: FormErrors = {};
    if (!payload) {
      errors.formType = 'Action Type is required.';
      if (!formData.title.trim()) errors.title = 'Title is required.';
      if (!formData.description.trim()) errors.description = 'Description is required.';
    } else {
      const context = protocolParams
        ? toValidationContext(protocolParams)
        : {
            feeRateRange: { min: 0, max: 0 },
            maxDiscountRateRange: { min: 0, max: 0 },
            currentFeeRateBps: null,
            currentMaxDiscountRateBps: null,
            acceptedTokenAddresses: [],
          };
      const result = validateProposalPayload(payload, context);
      if (!result.ok) {
        for (const [field, message] of Object.entries(issuesByField(result.issues))) {
          if (!protocolParams && CHAIN_DEPENDENT_FIELDS.has(field as keyof FormData)) continue;
          errors[field as keyof FormData] = message;
        }
      }
      if (formData.formType === 'AddToken' && tokenLookupError) {
        errors.tokenAddress = tokenLookupError;
      }
    }
    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  }, [
    payload,
    formData.title,
    formData.description,
    formData.formType,
    protocolParams,
    tokenLookupError,
  ]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmittingRef.current || submitting) return;
    if (!isConnected || !address || !protocolParams || !payload) return;
    if (!validateForm()) return;

    isSubmittingRef.current = true;
    setSubmitting(true);
    setStage(null);
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
      const { proposalId } = await createProposal(payload, address, signTx, {
        walletNetwork,
        context: toValidationContext(protocolParams),
        onStage: setStage,
        onConfirmed: async () => {
          await invalidateGovernanceQueries({
            voterAddress: address,
          });
        },
      });
      router.push(`/governance/${proposalId}`);
    } catch (error: unknown) {
      setStage(null);
      if (error instanceof ProposalValidationError) {
        setFormErrors(issuesByField(error.issues));
      } else {
        setFormErrors({ submit: describeSubmitError(error) });
      }
    } finally {
      isSubmittingRef.current = false;
      setSubmitting(false);
    }
  };

  const requiredBalance = protocolParams ? requiredProposerBalance(protocolParams) : null;
  const insufficientBalance =
    balance !== null && requiredBalance !== null && balance < requiredBalance;

  const isSubmitDisabled = useMemo(() => {
    const hasErrors = Object.keys(formErrors).some((key) => key !== 'submit');
    const isFormEmpty = !formData.formType || !formData.title || !formData.description;
    return (
      hasErrors ||
      isFormEmpty ||
      !protocolParams ||
      balance === null ||
      insufficientBalance ||
      submitting ||
      loadingParams
    );
  }, [
    formErrors,
    formData,
    protocolParams,
    balance,
    insufficientBalance,
    submitting,
    loadingParams,
  ]);

  const currentParameterValue = useMemo(() => {
    if (!protocolParams) return '';
    switch (formData.formType) {
      case 'FeeRate':
        return protocolParams.feeRateBps === null
          ? 'its current value (not confirmed on-chain)'
          : formatBps(protocolParams.feeRateBps);
      case 'MaxDiscountRate':
        return protocolParams.maxDiscountRateBps === null
          ? 'its current value (not confirmed on-chain)'
          : formatBps(protocolParams.maxDiscountRateBps);
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
        const value = formData.newValueBps.trim() === '' ? NaN : Number(formData.newValueBps);
        return Number.isInteger(value) ? formatBps(value) : '';
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

  const rateRange =
    formData.formType === 'MaxDiscountRate'
      ? protocolParams?.maxDiscountRateRange
      : protocolParams?.feeRateRange;

  if (loadingParams) {
    return (
      <div className="flex justify-center items-center h-screen" role="status">
        <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
        <p className="ml-2">Loading protocol parameters...</p>
      </div>
    );
  }

  return (
    <main className="container mx-auto p-6 max-w-3xl">
      <GovernanceMockStatusBanner action="createProposal" />

      <h1 className="text-3xl font-bold mb-6">Create New Governance Proposal</h1>

      {paramsError && (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-200"
        >
          <p>{paramsError} Proposals cannot be submitted until they load.</p>
          <button type="button" className="mt-2 font-semibold underline" onClick={retryParams}>
            Retry
          </button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6" noValidate>
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
              placeholder={
                rateRange
                  ? `e.g., 350 for 3.5% (${rateRange.min}-${rateRange.max})`
                  : 'e.g., 350 for 3.5%'
              }
              min={rateRange?.min}
              max={rateRange?.max}
              step={1}
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
              Token Address (C...)
              <FieldTooltip content="Only Soroban token contracts can be accepted. ILN does not support fee-on-transfer tokens: the token must transfer the exact amount specified, with no fee deducted." />
            </span>
            <Input
              type="text"
              name="tokenAddress"
              value={formData.tokenAddress}
              onChange={handleChange}
              onBlur={validateForm}
              className="mt-1 block w-full"
              placeholder="e.g., C... (Soroban token contract ID)"
              aria-describedby={formErrors.tokenAddress ? 'tokenAddress-error' : undefined}
              aria-invalid={Boolean(formErrors.tokenAddress)}
              required
            />
            {resolvedToken && (
              <p className="text-sm text-green-600 dark:text-green-400 mt-1">
                Resolved: {resolvedToken.name} ({resolvedToken.symbol}, {resolvedToken.decimals}{' '}
                decimals)
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

        {isConnected && balanceError && (
          <div role="alert" className="text-red-500 text-sm">
            {balanceError}{' '}
            <button
              type="button"
              className="font-semibold underline"
              onClick={() => setBalanceAttempt((n) => n + 1)}
            >
              Retry
            </button>
          </div>
        )}

        {isConnected && insufficientBalance && protocolParams && balance !== null && (
          <div className="text-red-500 text-sm">
            Your current ILN balance ({formatTokenAmount(balance, protocolParams.govTokenDecimals)})
            is below the minimum required to submit a proposal (
            {formatTokenAmount(requiredBalance!, protocolParams.govTokenDecimals)}).
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

        <p role="status" aria-live="polite" className="text-sm text-zinc-600 dark:text-zinc-400">
          {stage ? STAGE_LABELS[stage] : ''}
        </p>

        {formErrors.submit && (
          <div role="alert" className="text-red-500 text-sm">
            {formErrors.submit}
          </div>
        )}

        <Button
          type="submit"
          className="w-full"
          disabled={isSubmitDisabled || !isConnected || !address}
          aria-busy={submitting}
        >
          {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          Submit Proposal
        </Button>
        {!isConnected && (
          <p className="text-center text-sm text-zinc-500">
            Connect your wallet to submit a proposal.
          </p>
        )}
      </form>
      {signingModal}
    </main>
  );
}
