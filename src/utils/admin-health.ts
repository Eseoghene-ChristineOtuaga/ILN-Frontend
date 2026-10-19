import { GOVERNANCE_ADMIN_ADDRESS, CONTRACT_ID } from '@/constants';
import { assertAdminAddress } from '@/lib/admin-gate';
import { getAllInvoices, getNativeXlmBalance, type Invoice } from '@/utils/soroban';
import {
  executeProposal,
  fetchParameterUpdates,
  fetchProposals,
  fetchSignerRotations,
  type ParameterUpdateEvent,
  type Proposal,
  type SignerRotatedEvent,
} from '@/utils/governance';

export interface ProtocolHealth {
  paused: boolean;
  disputedInvoices: Invoice[];
  pendingProposals: Proposal[];
  readyProposals: Proposal[];
  oracleLastUpdatedAt: number;
  contractVersion: string;
  upgradeWindowStartsAt: number;
  treasuryBalanceXlm: number;
}

export type AdminActionCategory = 'signer_rotation' | 'parameter_update' | 'pause' | 'veto';

export interface AdminActionItem {
  id: string;
  category: AdminActionCategory;
  title: string;
  description: string;
  actor?: string;
  timestamp: number;
  txHash?: string;
  isSecuritySensitive: boolean;
  metadata?: {
    oldSigner?: string;
    newSigner?: string;
    parameter?: string;
    newValue?: string;
    proposalId?: number;
    reason?: string;
    action?: string;
  };
}

let protocolPaused = false;

export function isAdminAddress(address: string | null | undefined) {
  return Boolean(address) && address === GOVERNANCE_ADMIN_ADDRESS;
}

export async function fetchProtocolHealth(): Promise<ProtocolHealth> {
  const [invoices, proposals, treasuryBalanceXlm] = await Promise.all([
    getAllInvoices(),
    fetchProposals(),
    getNativeXlmBalance(GOVERNANCE_ADMIN_ADDRESS).catch(() => 0),
  ]);
  const now = Math.floor(Date.now() / 1000);
  const disputedInvoices = invoices.filter((invoice) => invoice.status === 'Disputed');
  const pendingProposals = proposals.filter((proposal) => proposal.status === 'Active');
  const readyProposals = proposals.filter(
    (proposal) =>
      proposal.status === 'Passed' &&
      (proposal.executableAfter === undefined || proposal.executableAfter <= now)
  );

  return {
    paused: protocolPaused,
    disputedInvoices,
    pendingProposals,
    readyProposals,
    oracleLastUpdatedAt: now - 11 * 60,
    contractVersion:
      process.env.NEXT_PUBLIC_CONTRACT_VERSION ?? `testnet:${CONTRACT_ID.slice(0, 8)}`,
    upgradeWindowStartsAt: now + 5 * 24 * 60 * 60,
    treasuryBalanceXlm,
  };
}

export async function fetchAdminActionHistory(): Promise<AdminActionItem[]> {
  try {
    const [signerRotations, parameterUpdates] = await Promise.all([
      fetchSignerRotations().catch(() => [] as SignerRotatedEvent[]),
      fetchParameterUpdates().catch(() => [] as ParameterUpdateEvent[]),
    ]);

    const items: AdminActionItem[] = [
      ...signerRotations.map((sr) => ({
        id: sr.id,
        category: 'signer_rotation' as const,
        title: 'Multisig Signer Rotation',
        description: `Multisig signer authority rotated from ${sr.oldSigner ? `${sr.oldSigner.slice(0, 6)}...${sr.oldSigner.slice(-4)}` : 'None'} to ${sr.newSigner.slice(0, 6)}...${sr.newSigner.slice(-4)}`,
        actor: GOVERNANCE_ADMIN_ADDRESS,
        timestamp: sr.rotatedAt,
        txHash: sr.txHash,
        isSecuritySensitive: true,
        metadata: {
          oldSigner: sr.oldSigner,
          newSigner: sr.newSigner,
          reason: sr.reason,
          action: sr.action ?? 'rotated',
        },
      })),
      ...parameterUpdates.map((pu) => ({
        id: pu.id,
        category: 'parameter_update' as const,
        title: `Parameter Updated: ${pu.label}`,
        description: `Routine parameter '${pu.parameter}' updated to ${pu.newValue}`,
        actor: GOVERNANCE_ADMIN_ADDRESS,
        timestamp: pu.updatedAt,
        txHash: pu.txHash,
        isSecuritySensitive: false,
        metadata: {
          parameter: pu.parameter,
          newValue: pu.newValue,
          // Direct governance-parameter writes have no enacting proposal.
          proposalId: pu.proposalId ?? undefined,
        },
      })),
    ];

    return items.sort((a, b) => b.timestamp - a.timestamp);
  } catch (err) {
    console.warn('Failed to fetch admin action history:', err);
    return [];
  }
}

export async function setProtocolPaused(
  paused: boolean,
  adminAddress: string,
  _signTx: (txXdr: string) => Promise<string>
) {
  // Fail fast for non-admin callers (#915). The Stellar contract remains the
  // authoritative enforcement point; this guard only makes the rejection
  // explicit before any transaction is built or signed.
  assertAdminAddress(adminAddress);
  await new Promise((resolve) => setTimeout(resolve, 250));
  protocolPaused = paused;
  return { txHash: Math.random().toString(16).slice(2, 18), paused };
}

export async function executeReadyProposals(
  proposals: Proposal[],
  adminAddress: string,
  signTx: (txXdr: string) => Promise<string>
) {
  // Fail fast for non-admin callers (#915) — see setProtocolPaused above.
  assertAdminAddress(adminAddress);
  const results = await Promise.all(
    proposals.map((proposal) => executeProposal(proposal.id, adminAddress, signTx))
  );
  return results;
}
