/**
 * Proposal creation transaction (#1055).
 *
 * build → simulate → sign → submit → confirm, against the deployed
 * `iln_governance.create_proposal`. Every stage has an explicit outcome:
 *
 *   validating          payload checked against the contract schema (#1056)
 *   building            source account loaded, invocation assembled
 *   simulating          dry-run; contract errors are decoded and surfaced
 *   awaiting_signature  wallet prompt (declining changes nothing)
 *   submitting          sendTransaction
 *   confirming          polling until the ledger closes the transaction
 *   confirmed           the chain returned the new proposal id
 *
 * Nothing local is mutated at any point: the created proposal is read back
 * from the chain by the normal proposal queries.
 */

import {
  BASE_FEE,
  Operation,
  TransactionBuilder,
  rpc,
  scValToNative,
  type Transaction,
} from '@stellar/stellar-sdk';
import { isCancellationError } from '@/lib/transaction-lifecycle';
import { networksMatch } from '@/utils/network';
import { recordPendingTransaction, removePendingTransaction } from '@/lib/pending-transactions';
import {
  ProposalValidationError,
  encodeCreateProposalArgs,
  proposalDescriptionHash,
  toHex,
  validateProposalPayload,
  type CreateProposalPayload,
  type ProposalValidationContext,
} from './contract-schema';

export type CreateProposalStage =
  | 'validating'
  | 'building'
  | 'simulating'
  | 'awaiting_signature'
  | 'submitting'
  | 'confirming'
  | 'confirmed';

export type CreateProposalErrorCode =
  | 'NETWORK_MISMATCH'
  | 'SIMULATION_FAILED'
  | 'USER_REJECTED'
  | 'SUBMISSION_FAILED'
  | 'TRANSACTION_FAILED'
  | 'CONFIRMATION_TIMEOUT'
  | 'INVALID_RESPONSE';

/** `iln_governance::GovernanceError` codes a proposal creation can hit. */
const GOVERNANCE_ERRORS: Record<number, { name: string; message: string }> = {
  14: { name: 'Unauthorized', message: 'The proposer did not authorize this proposal.' },
  19: {
    name: 'InsufficientProposerBalance',
    message:
      'Your ILN balance is below the minimum required to create a proposal (including the deposit).',
  },
  26: {
    name: 'InvalidProposalDeposit',
    message: 'The governance contract has an invalid deposit configured.',
  },
  28: { name: 'NotInitialized', message: 'The governance contract has not been initialized.' },
};

export interface ContractErrorInfo {
  code: number;
  name: string;
}

export class CreateProposalError extends Error {
  constructor(
    readonly code: CreateProposalErrorCode,
    readonly stage: CreateProposalStage,
    message: string,
    readonly details: { contractError?: ContractErrorInfo; txHash?: string } = {},
    options?: { cause?: unknown }
  ) {
    super(`${code}: ${message}`, options);
    this.name = 'CreateProposalError';
  }
}

/** Decode `Error(Contract, #N)` from a simulation / result diagnostic. */
export function decodeContractError(diagnostic: string): ContractErrorInfo | null {
  const match = diagnostic.match(/Error\(Contract,\s*#(\d+)\)/);
  if (!match) return null;
  const code = Number(match[1]);
  return { code, name: GOVERNANCE_ERRORS[code]?.name ?? `GovernanceError#${code}` };
}

type ProposalServer = Pick<
  rpc.Server,
  | 'getAccount'
  | 'simulateTransaction'
  | 'prepareTransaction'
  | 'sendTransaction'
  | 'pollTransaction'
>;

export interface CreateProposalRequest {
  payload: CreateProposalPayload;
  proposer: string;
  signTx: (txXdr: string) => Promise<string>;
  context: ProposalValidationContext;
  server: ProposalServer;
  governanceContractId: string;
  networkPassphrase: string;
  onStage?: (stage: CreateProposalStage) => void;
  pollAttempts?: number;
  walletNetwork?: string;
}

export interface CreatedProposal {
  /** Id returned by `create_proposal` in the confirmed transaction. */
  proposalId: number;
  txHash: string;
  /** Hex `description_hash` committed on-chain, for publishing the text. */
  descriptionHash: string;
  ledger: number;
}

const ACCEPTED_SEND_STATUSES = new Set(['PENDING', 'DUPLICATE']);
const DEFAULT_POLL_ATTEMPTS = 20;

function decodeProposalId(value: unknown): number | null {
  const id = typeof value === 'bigint' ? value : typeof value === 'number' ? BigInt(value) : null;
  if (id === null || id <= 0n || id > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(id);
}

export async function submitCreateProposal({
  payload,
  proposer,
  signTx,
  context,
  server,
  governanceContractId,
  networkPassphrase,
  onStage,
  pollAttempts = DEFAULT_POLL_ATTEMPTS,
  walletNetwork,
}: CreateProposalRequest): Promise<CreatedProposal> {
  if (
    walletNetwork &&
    !networksMatch(walletNetwork, networkPassphrase.includes('Public') ? 'mainnet' : 'testnet')
  ) {
    throw new CreateProposalError(
      'NETWORK_MISMATCH',
      'validating',
      `Network mismatch detected. Configured network differs from wallet network (${walletNetwork}). Transactions cannot be signed.`
    );
  }

  // ── validating ───────────────────────────────────────────────────────────
  onStage?.('validating');
  const validation = validateProposalPayload(payload, context);
  if (!validation.ok) throw new ProposalValidationError(validation.issues);
  const proposal = validation.proposal;

  // ── building ─────────────────────────────────────────────────────────────
  onStage?.('building');
  const [sourceAccount, args, hash] = await Promise.all([
    server.getAccount(proposer),
    encodeCreateProposalArgs(proposer, proposal),
    proposalDescriptionHash(proposal.title, proposal.description),
  ]);
  const tx = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      Operation.invokeContractFunction({
        contract: governanceContractId,
        function: 'create_proposal',
        args,
      })
    )
    .setTimeout(60)
    .build();

  // ── simulating ───────────────────────────────────────────────────────────
  onStage?.('simulating');
  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await server.simulateTransaction(tx);
  } catch (error) {
    throw new CreateProposalError(
      'SIMULATION_FAILED',
      'simulating',
      'Simulation could not be completed.',
      {},
      { cause: error }
    );
  }
  if (!rpc.Api.isSimulationSuccess(simulation)) {
    const diagnostic = 'error' in simulation && simulation.error ? String(simulation.error) : '';
    const contractError = decodeContractError(diagnostic);
    const message = contractError
      ? (GOVERNANCE_ERRORS[contractError.code]?.message ??
        `The contract rejected the proposal (${contractError.name}).`)
      : 'The governance contract rejected this proposal in simulation.';
    throw new CreateProposalError('SIMULATION_FAILED', 'simulating', message, {
      ...(contractError ? { contractError } : {}),
    });
  }

  // ── awaiting_signature ───────────────────────────────────────────────────
  let prepared: Transaction;
  try {
    prepared = (await server.prepareTransaction(tx)) as Transaction;
  } catch (error) {
    throw new CreateProposalError(
      'SIMULATION_FAILED',
      'simulating',
      'The transaction could not be prepared for signing.',
      {},
      { cause: error }
    );
  }
  onStage?.('awaiting_signature');
  let signedXdr: string;
  try {
    signedXdr = await signTx(prepared.toXDR());
  } catch (error) {
    if (isCancellationError(error)) {
      throw new CreateProposalError(
        'USER_REJECTED',
        'awaiting_signature',
        'Transaction signature was declined in wallet. No proposal was created.',
        {},
        { cause: error }
      );
    }
    throw error;
  }

  // ── submitting ───────────────────────────────────────────────────────────
  onStage?.('submitting');
  const signedTx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase) as Transaction;
  let sent: rpc.Api.SendTransactionResponse;
  try {
    sent = await server.sendTransaction(signedTx);
  } catch (error) {
    throw new CreateProposalError(
      'SUBMISSION_FAILED',
      'submitting',
      'The network did not accept the transaction.',
      {},
      { cause: error }
    );
  }
  if (!sent?.hash || !sent.status) {
    throw new CreateProposalError(
      'INVALID_RESPONSE',
      'submitting',
      'RPC returned an invalid submission response.'
    );
  }
  if (!ACCEPTED_SEND_STATUSES.has(sent.status)) {
    throw new CreateProposalError(
      'SUBMISSION_FAILED',
      'submitting',
      `Transaction submission failed with status ${sent.status}.`,
      { txHash: sent.hash }
    );
  }

  // ── confirming ───────────────────────────────────────────────────────────
  // Recorded before polling so a reload mid-confirmation can be reconciled
  // from network truth instead of being forgotten (#1143).
  recordPendingTransaction({ hash: sent.hash, label: 'create_proposal' });
  onStage?.('confirming');
  const final = await server.pollTransaction(sent.hash, { attempts: pollAttempts });

  if (final.status === rpc.Api.GetTransactionStatus.FAILED) {
    removePendingTransaction(sent.hash);
    throw new CreateProposalError(
      'TRANSACTION_FAILED',
      'confirming',
      'The proposal transaction failed on-chain.',
      {
        txHash: sent.hash,
      }
    );
  }
  if (final.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    // Not found within the polling budget: the pending entry is kept so the
    // reconciler can settle it later. No verdict is assumed.
    throw new CreateProposalError(
      'CONFIRMATION_TIMEOUT',
      'confirming',
      'The transaction was submitted but is not confirmed yet. Check its status before retrying.',
      { txHash: sent.hash }
    );
  }
  removePendingTransaction(sent.hash);

  const success = final as rpc.Api.GetSuccessfulTransactionResponse;
  let returned: unknown;
  try {
    returned = success.returnValue ? scValToNative(success.returnValue) : undefined;
  } catch {
    returned = undefined;
  }
  const proposalId = decodeProposalId(returned);
  if (proposalId === null) {
    throw new CreateProposalError(
      'INVALID_RESPONSE',
      'confirming',
      'The transaction confirmed but did not return a proposal id.',
      { txHash: sent.hash }
    );
  }

  onStage?.('confirmed');
  return {
    proposalId,
    txHash: sent.hash,
    descriptionHash: toHex(hash),
    ledger: success.ledger,
  };
}
