import { describe, expect, it } from 'vitest';
import {
  formatMockInventoryMarkdown,
  scanMockInventory,
} from '../../../scripts/generate-mock-inventory.mjs';

describe('scanMockInventory', () => {
  it('returns valid inventory structure with summary counts matching items', () => {
    const data = scanMockInventory();

    expect(data.summary.totalFunctions).toBe(data.functions.length);
    expect(data.summary.totalFunctions).toBeGreaterThan(0);
    expect(data.summary.realCount).toBeGreaterThan(0);
    expect(data.summary.mockCount).toBeGreaterThan(0);

    const calculatedReal = data.functions.filter(
      (f: { status: string }) => f.status === 'Real'
    ).length;
    const calculatedDerived = data.functions.filter(
      (f: { status: string }) => f.status === 'Derived'
    ).length;
    const calculatedDeferred = data.functions.filter(
      (f: { status: string }) => f.status === 'Deferred'
    ).length;
    const calculatedMock = data.functions.filter(
      (f: { status: string }) => f.status === 'Mock'
    ).length;

    expect(data.summary.realCount).toBe(calculatedReal);
    expect(data.summary.derivedCount).toBe(calculatedDerived);
    expect(data.summary.deferredCount).toBe(calculatedDeferred);
    expect(data.summary.mockCount).toBe(calculatedMock);
    expect(data.summary.patternFindingsCount).toBe(data.findings.length);
  });

  it('tracks known governance write mocks with their remediation tracking issues', () => {
    const data = scanMockInventory();

    const castVote = data.functions.find((f: { name: string }) => f.name === 'castVote');
    expect(castVote).toBeDefined();
    // Real since #1044/#1045: a signed Soroban cast_vote, simulated before
    // signing and confirmed under a bounded poll.
    expect(castVote?.status).toBe('Real');
    expect(castVote?.trackingIssue).toBe('#1044');

    const createProposal = data.functions.find(
      (f: { name: string }) => f.name === 'createProposal'
    );
    expect(createProposal).toBeDefined();
    expect(createProposal?.status).toBe('Real');
    expect(createProposal?.trackingIssue).toBe('#1044');

    const delegateVotingPower = data.functions.find(
      (f: { name: string }) => f.name === 'delegateVotingPower'
    );
    expect(delegateVotingPower).toBeDefined();
    expect(delegateVotingPower?.status).toBe('Mock');
    expect(delegateVotingPower?.trackingIssue).toBe('#842');
  });

  it('tracks verified real contract integrations', () => {
    const data = scanMockInventory();

    const submitInvoice = data.functions.find((f: { name: string }) => f.name === 'submitInvoice');
    expect(submitInvoice).toBeDefined();
    expect(submitInvoice?.status).toBe('Real');

    const fundInvoice = data.functions.find((f: { name: string }) => f.name === 'fundInvoice');
    expect(fundInvoice).toBeDefined();
    expect(fundInvoice?.status).toBe('Real');

    const lookupToken = data.functions.find((f: { name: string }) => f.name === 'lookupToken');
    expect(lookupToken).toBeDefined();
    expect(lookupToken?.status).toBe('Real');
    expect(lookupToken?.trackingIssue).toBe('#845');
  });
});

describe('formatMockInventoryMarkdown', () => {
  it('generates markdown with table and cross-links', () => {
    const data = scanMockInventory();
    const markdown = formatMockInventoryMarkdown(data);

    expect(markdown).toContain('# Mock Usage & Contract Integration Inventory');
    expect(markdown).toContain('contract-integration-status.md');
    expect(markdown).toContain('governance-mock-regression-retrospective.md');
    expect(markdown).toContain('frontend-mock-closure-audit.md');
    expect(markdown).toContain('Executive Summary');
    expect(markdown).toContain('Contract Integration Functions Inventory');
    expect(markdown).toContain('Detected Code Pattern Signatures');
    expect(markdown).toContain('MSW Development & Testing Mocks');
    expect(markdown).toContain('castVote');
    expect(markdown).toContain('submitInvoice');
  });
});
