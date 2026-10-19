'use client';

import { useEffect, useMemo, useState } from 'react';
import { GOVERNANCE_ADMIN_ADDRESS } from '@/constants';
import { useToast } from '@/context/ToastContext';
import { useWallet } from '@/context/WalletContext';
import { AcceptedToken, createProposal, fetchProtocolParameters } from '@/utils/governance';
import { formatAddress } from '@/utils/format';
import { CONTRACT_ERROR_MAP, parseContractError } from '@/lib/contract/errors';
import { GovernanceTxError } from '@/lib/governance-tx';
import FieldTooltip from '@/components/FieldTooltip';
import GovernanceMockStatusBanner from '@/components/governance/GovernanceMockStatusBanner';

/**
 * Message for a failed allowlist proposal.
 *
 * A `GovernanceTxError` already carries a user-facing remediation (#1044,
 * #1045) — including the distinction between "we stopped waiting" and
 * "it failed" — so it is preferred over the generic contract-error map.
 */
function proposalFailureMessage(error: unknown): string {
  if (error instanceof GovernanceTxError) {
    return error.remediation;
  }
  const code = parseContractError(error);
  if (code) {
    return CONTRACT_ERROR_MAP[code].message;
  }
  return error instanceof Error ? error.message : 'Transaction rejected';
}

/** A timeout leaves the outcome unknown, so it must not read as a failure. */
function proposalFailureTitle(error: unknown): string {
  if (error instanceof GovernanceTxError && error.code === 'TX_TIMEOUT') {
    return 'Still confirming — outcome unknown';
  }
  return 'Proposal failed';
}

interface TokenRow extends AcceptedToken {
  decimals: number;
  dateAdded: string;
  pendingRemoval?: boolean;
  removalEffectiveAt?: number;
}

const FALLBACK_DECIMALS: Record<string, number> = {
  USDC: 6,
  EURC: 6,
  XLM: 7,
};
const TOKEN_ADDRESS_RE = /^[CG][A-Z2-7]{55}$/;

function tokenRows(tokens: AcceptedToken[]): TokenRow[] {
  return tokens.map((token, index) => ({
    ...token,
    decimals: FALLBACK_DECIMALS[token.symbol] ?? 7,
    dateAdded: new Date(Date.now() - (index + 12) * 86400_000).toLocaleDateString(),
    pendingRemoval: index === tokens.length - 1,
    removalEffectiveAt: index === tokens.length - 1 ? Date.now() + 3 * 86400_000 : undefined,
  }));
}

export default function TokenAllowlistPanel() {
  const { address, isConnected, signTx } = useWallet();
  const { addToast, updateToast } = useToast();
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [tokenAddress, setTokenAddress] = useState('');
  const [decimals, setDecimals] = useState('6');
  const [submitting, setSubmitting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const isAdmin = isConnected && address === GOVERNANCE_ADMIN_ADDRESS;

  useEffect(() => {
    let cancelled = false;
    fetchProtocolParameters()
      .then((params) => {
        if (!cancelled) setTokens(tokenRows(params.acceptedTokens));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const pendingRemoval = useMemo(() => tokens.filter((token) => token.pendingRemoval), [tokens]);

  const submitAddToken = async () => {
    if (!address || !isAdmin) return;
    if (!TOKEN_ADDRESS_RE.test(tokenAddress.trim())) {
      addToast({
        type: 'error',
        title: 'Invalid token address',
        message: 'Token addresses must be valid Stellar account or contract addresses.',
      });
      return;
    }

    setSubmitting(true);
    const toastId = addToast({ type: 'pending', title: 'Creating add-token proposal...' });
    try {
      const { txHash } = await createProposal(
        {
          formType: 'AddToken',
          tokenAddress: tokenAddress.trim(),
          tokenName: `Token (${decimals} decimals)`,
          title: `Add token ${formatAddress(tokenAddress)}`,
          description: `Add ${tokenAddress.trim()} to the protocol token allowlist with ${decimals} expected decimals.`,
        },
        address,
        signTx
      );
      updateToast(toastId, { type: 'success', title: 'Add-token proposal created', txHash });
      setTokenAddress('');
      setDecimals('6');
    } catch (error) {
      updateToast(toastId, {
        type:
          error instanceof GovernanceTxError && error.code === 'TX_TIMEOUT' ? 'warning' : 'error',
        title: proposalFailureTitle(error),
        message: proposalFailureMessage(error),
      });
    } finally {
      setSubmitting(false);
    }
  };

  const submitRemoveToken = async (token: TokenRow) => {
    if (!address || !isAdmin) return;
    setRemoving(token.address);
    const toastId = addToast({
      type: 'pending',
      title: `Creating removal proposal for ${token.symbol}...`,
    });
    try {
      const { txHash } = await createProposal(
        {
          formType: 'RemoveToken',
          removeTokenAddress: token.address,
          title: `Remove ${token.symbol} from token allowlist`,
          description: `Create a governance proposal to remove ${token.symbol} (${token.address}) from accepted invoice tokens.`,
        },
        address,
        signTx
      );
      updateToast(toastId, { type: 'success', title: 'Remove-token proposal created', txHash });
      setTokens((current) =>
        current.map((item) =>
          item.address === token.address
            ? { ...item, pendingRemoval: true, removalEffectiveAt: Date.now() + 3 * 86400_000 }
            : item
        )
      );
    } catch (error) {
      updateToast(toastId, {
        type:
          error instanceof GovernanceTxError && error.code === 'TX_TIMEOUT' ? 'warning' : 'error',
        title: proposalFailureTitle(error),
        message: proposalFailureMessage(error),
      });
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section className="mt-10 rounded-2xl border border-outline-variant/20 bg-surface-container-lowest p-6">
      <GovernanceMockStatusBanner action="createProposal" />

      <div className="mb-6 flex flex-col justify-between gap-4 md:flex-row md:items-start">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-primary">
            Governance Admin
          </p>
          <h2 className="mt-1 text-2xl font-headline">Token Allowlist</h2>
          <p className="mt-2 max-w-2xl text-sm text-on-surface-variant">
            Review accepted invoice tokens and create governance proposals to add or remove assets.
          </p>
        </div>
        {!isAdmin && (
          <span className="rounded-full border border-outline-variant/30 px-3 py-1 text-xs font-semibold text-on-surface-variant">
            Read-only
          </span>
        )}
      </div>

      {pendingRemoval.length > 0 && (
        <div className="mb-5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-700">
          {pendingRemoval.map((token) => (
            <p key={token.address}>
              {token.symbol} pending removal in{' '}
              {Math.max(
                0,
                Math.ceil(((token.removalEffectiveAt ?? Date.now()) - Date.now()) / 86400_000)
              )}{' '}
              days.
            </p>
          ))}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-outline-variant/10">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface-container">
            <tr>
              {['Token', 'Address', 'Decimals', 'Date added', 'Status', 'Action'].map((heading) => (
                <th
                  key={heading}
                  className="px-4 py-3 text-xs font-bold uppercase text-on-surface-variant"
                >
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/10">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-on-surface-variant">
                  Loading tokens...
                </td>
              </tr>
            ) : (
              tokens.map((token) => (
                <tr key={token.address}>
                  <td className="px-4 py-4">
                    <div className="flex items-center gap-3">
                      <span className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-xs font-black text-primary">
                        {token.symbol.slice(0, 2)}
                      </span>
                      <div>
                        <p className="font-semibold">{token.symbol}</p>
                        <p className="text-xs text-on-surface-variant">{token.name}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-4 font-mono text-xs">{formatAddress(token.address)}</td>
                  <td className="px-4 py-4">{token.decimals}</td>
                  <td className="px-4 py-4">{token.dateAdded}</td>
                  <td className="px-4 py-4">
                    {token.pendingRemoval ? (
                      <span className="rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-700">
                        Pending removal
                      </span>
                    ) : (
                      <span className="rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-700">
                        Active
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-4">
                    <button
                      onClick={() => void submitRemoveToken(token)}
                      disabled={!isAdmin || removing === token.address}
                      className="rounded-lg border border-red-500/30 px-3 py-2 text-xs font-bold text-red-600 disabled:opacity-40"
                    >
                      {removing === token.address ? 'Creating...' : 'Remove Token'}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-6 grid gap-4 rounded-xl bg-surface-container p-4 md:grid-cols-[1fr_160px_auto]">
        <div>
          <span className="mb-1 inline-flex items-center text-xs font-semibold text-on-surface-variant">
            Token contract address
            <FieldTooltip content="ILN does not support fee-on-transfer tokens. The token must transfer the exact amount specified, with no fee deducted." />
          </span>
          <input
            value={tokenAddress}
            onChange={(event) => setTokenAddress(event.target.value)}
            disabled={!isAdmin}
            className="w-full rounded-xl border border-outline-variant/30 bg-surface-container-lowest px-4 py-3 text-sm outline-none focus:border-primary disabled:opacity-50"
            placeholder="Token contract address"
          />
        </div>
        <input
          type="number"
          min={0}
          max={18}
          value={decimals}
          onChange={(event) => setDecimals(event.target.value)}
          disabled={!isAdmin}
          className="rounded-xl border border-outline-variant/30 bg-surface-container-lowest px-4 py-3 text-sm outline-none focus:border-primary disabled:opacity-50"
          placeholder="Decimals"
        />
        <button
          onClick={() => void submitAddToken()}
          disabled={!isAdmin || submitting}
          className="rounded-xl bg-primary px-5 py-3 text-sm font-bold text-white disabled:opacity-50"
        >
          {submitting ? 'Creating...' : 'Add Token'}
        </button>
      </div>
    </section>
  );
}
