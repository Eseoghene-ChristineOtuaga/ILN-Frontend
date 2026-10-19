/**
 * Governance write simulation gate (#1063).
 *
 * Soroban transactions are simulated before a wallet is asked to sign them.
 * When the simulation fails there is nothing to sign: the failure must be
 * rendered to the user and the wallet prompt must never open. Running the
 * simulation first also guarantees that a rejected simulation cannot mutate
 * local governance state or invalidate query caches.
 */

/** Stable error code consumed by callers / telemetry. */
export const GOVERNANCE_SIMULATION_FAILED = 'GOVERNANCE_SIMULATION_FAILED';

/**
 * Result of a governance dry-run. `success: true` is the only outcome that
 * allows signing; everything else is surfaced as a simulation failure.
 */
export interface GovernanceSimulationOutcome {
  success: boolean;
  /** Contract / RPC diagnostic shown to the user. */
  error?: string;
}

/** Thrown before any signature request when a governance simulation fails. */
export class GovernanceSimulationError extends Error {
  readonly code = GOVERNANCE_SIMULATION_FAILED;

  constructor(detail?: string, options?: { cause?: unknown }) {
    super(
      `${GOVERNANCE_SIMULATION_FAILED}: ${
        detail && detail.trim().length > 0
          ? detail
          : 'The governance transaction failed simulation and was not submitted.'
      }`,
      options
    );
    this.name = 'GovernanceSimulationError';
  }
}

/** True for a simulation failure produced by this module. */
export function isGovernanceSimulationError(error: unknown): error is GovernanceSimulationError {
  return error instanceof GovernanceSimulationError;
}

/**
 * Run a governance dry-run and throw a typed error when it does not succeed.
 *
 * Callers must invoke this before `signTx`. A thrown error therefore means the
 * wallet prompt was never opened and no state was mutated.
 */
export async function assertGovernanceSimulationPassed(
  simulate: () => Promise<GovernanceSimulationOutcome>
): Promise<void> {
  let outcome: GovernanceSimulationOutcome;
  try {
    outcome = await simulate();
  } catch (error) {
    throw new GovernanceSimulationError('Simulation could not be completed.', { cause: error });
  }

  if (outcome?.success !== true) {
    throw new GovernanceSimulationError(outcome?.error);
  }
}
