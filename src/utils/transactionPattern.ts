import type { DecodedTransaction } from './decodeTransaction';

export type ExpectedTransactionAction =
  | 'approve'
  | 'cancel_invoice'
  | 'cast_vote'
  | 'create_proposal'
  | 'dispute_invoice'
  | 'execute_proposal'
  | 'fund_invoice'
  | 'mark_paid'
  | 'submit_invoice'
  | 'veto_proposal';

interface TransactionShape {
  argumentTypeVariants: string[][];
  functionName: ExpectedTransactionAction;
}

const EXPECTED_TRANSACTION_SHAPES: Record<ExpectedTransactionAction, TransactionShape> = {
  approve: {
    functionName: 'approve',
    argumentTypeVariants: [['address', 'address', 'i128', 'u32']],
  },
  cancel_invoice: { functionName: 'cancel_invoice', argumentTypeVariants: [['u64']] },
  cast_vote: { functionName: 'cast_vote', argumentTypeVariants: [['address', 'u64', 'u32']] },
  // Governance mutations (#1044, #1045). Listing them here means the signing
  // preview validates a governance payload against its expected shape before
  // the user approves it, the same as the invoice actions.
  create_proposal: {
    functionName: 'create_proposal',
    argumentTypeVariants: [['address', 'u32', 'string', 'string', 'string']],
  },
  execute_proposal: {
    functionName: 'execute_proposal',
    argumentTypeVariants: [['address', 'u64']],
  },
  veto_proposal: {
    functionName: 'veto_proposal',
    argumentTypeVariants: [['address', 'u64', 'string']],
  },
  dispute_invoice: { functionName: 'dispute_invoice', argumentTypeVariants: [['u64', 'string']] },
  fund_invoice: {
    functionName: 'fund_invoice',
    argumentTypeVariants: [['address', 'u64', 'i128']],
  },
  mark_paid: { functionName: 'mark_paid', argumentTypeVariants: [['u64', 'i128']] },
  submit_invoice: {
    functionName: 'submit_invoice',
    argumentTypeVariants: [
      ['address', 'address', 'i128', 'u64', 'u32'],
      ['address', 'address', 'i128', 'u64', 'u32', 'address'],
      ['address', 'address', 'i128', 'u64', 'u32', 'address', 'string'],
    ],
  },
};

/**
 * Returns human-readable discrepancies between the UI action and the decoded XDR.
 * This is intentionally advisory: users must be able to inspect and decide whether
 * to sign a transaction even when an integration evolves ahead of this allowlist.
 */
export function findTransactionPatternMismatches(
  decoded: DecodedTransaction | null,
  expectedAction?: ExpectedTransactionAction
): string[] {
  if (!expectedAction) return [];
  if (!decoded) return ['The transaction could not be decoded.'];

  const expected = EXPECTED_TRANSACTION_SHAPES[expectedAction];
  const mismatches: string[] = [];

  if (decoded.operations.length !== 1) {
    mismatches.push(
      `Expected one ${expected.functionName} operation, but found ${decoded.operations.length} operations.`
    );
  }

  const operation = decoded.operations[0];
  if (!operation) return mismatches;

  if (operation.functionName !== expected.functionName) {
    mismatches.push(
      `Expected ${expected.functionName}, but the payload calls ${operation.functionName}.`
    );
  }

  const actualArgumentTypes = operation.args.map((argument) => argument.type);
  const shapeMatches = expected.argumentTypeVariants.some(
    (argumentTypes) =>
      actualArgumentTypes.length === argumentTypes.length &&
      actualArgumentTypes.every((type, index) => type === argumentTypes[index])
  );
  if (!shapeMatches) {
    mismatches.push(
      `Expected arguments matching (${expected.argumentTypeVariants
        .map((argumentTypes) => argumentTypes.join(', '))
        .join(') or (')}), but found (${actualArgumentTypes.join(', ')}).`
    );
  }

  return mismatches;
}
