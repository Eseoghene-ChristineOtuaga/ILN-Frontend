/**
 * Unit tests for deterministic governance contract event decoding fixtures (#1066).
 *
 * Covers:
 *  - proposal_created: proposal initialization event
 *  - proposal_executed: proposal enactment event
 *  - vote_cast: voter participation event (For, Against, Abstain)
 *  - proposal_vetoed: admin veto event
 *  - parameter_updated: protocol parameter mutation event
 *  - malformed payloads (missing topics, missing required fields, non-numeric values)
 *  - strict mode (throws EventDecodingError) vs non-strict mode (returns null)
 *  - regression guards: deterministic parsing without fabricated fallbacks
 */

import { describe, expect, it } from 'vitest';
import { nativeToScVal, xdr, rpc, Contract } from '@stellar/stellar-sdk';
import {
  decodeProposalCreatedEvent,
  decodeProposalExecutedEvent,
  decodeVoteCastEvent,
  decodeProposalVetoedEvent,
  decodeParameterUpdatedEvent,
  decodeGovernanceEvent,
  createProposalCreatedFixture,
  createProposalExecutedFixture,
  createVoteCastFixture,
  createProposalVetoedFixture,
  createParameterUpdatedFixture,
  createRawEventFixture,
  EventDecodingError,
} from '../event-decoding';

const GOV = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const VOTER = 'GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ADMIN = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

describe('Governance Event Decoding Fixtures (#1066)', () => {
  describe('decodeProposalCreatedEvent', () => {
    it('decodes a valid proposal_created event fixture', () => {
      const fixture = createProposalCreatedFixture(GOV, 42, VOTER, 'UpdateFeeRate', {
        ledger: 1050,
        txHash: '01'.repeat(32),
      });

      const decoded = decodeProposalCreatedEvent(fixture);
      expect(decoded).not.toBeNull();
      expect(decoded?.kind).toBe('proposal_created');
      expect(decoded?.proposalId).toBe(42);
      expect(decoded?.proposer).toBe(VOTER);
      expect(decoded?.actionType).toBe('UpdateFeeRate');
      expect(decoded?.title).toBe('Test Proposal Title');
      expect(decoded?.ledger).toBe(1050);
      expect(decoded?.txHash).toBe('01'.repeat(32));
    });

    it('returns null on malformed event with insufficient topics in non-strict mode', () => {
      const malformed = {
        topic: [nativeToScVal('proposal_created', { type: 'symbol' })],
        value: nativeToScVal(123),
      } as unknown as rpc.Api.EventResponse;

      expect(decodeProposalCreatedEvent(malformed)).toBeNull();
    });

    it('throws EventDecodingError on malformed event in strict mode', () => {
      const malformed = {
        topic: [nativeToScVal('proposal_created', { type: 'symbol' })],
        value: nativeToScVal(123),
      } as unknown as rpc.Api.EventResponse;

      expect(() => decodeProposalCreatedEvent(malformed, { strict: true })).toThrow(
        EventDecodingError
      );
      expect(() => decodeProposalCreatedEvent(malformed, { strict: true })).toThrow(
        /MALFORMED_EVENT_PAYLOAD/
      );
    });

    it('rejects invalid or negative proposal_id', () => {
      const invalid = createRawEventFixture(
        GOV,
        [
          nativeToScVal('proposal_created', { type: 'symbol' }),
          nativeToScVal(-1n, { type: 'i128' }),
        ],
        nativeToScVal(0)
      );

      expect(decodeProposalCreatedEvent(invalid)).toBeNull();
      expect(() => decodeProposalCreatedEvent(invalid, { strict: true })).toThrow(
        EventDecodingError
      );
    });
  });

  describe('decodeProposalExecutedEvent', () => {
    it('decodes a valid proposal_executed event fixture', () => {
      const fixture = createProposalExecutedFixture(GOV, 10, 'SetMaxDiscountRate', {
        ledger: 2000,
        txHash: '02'.repeat(32),
        proposedValue: 250,
        votesFor: 10000,
        votesAgainst: 1500,
      });

      const decoded = decodeProposalExecutedEvent(fixture);
      expect(decoded).not.toBeNull();
      expect(decoded?.kind).toBe('proposal_executed');
      expect(decoded?.proposalId).toBe(10);
      expect(decoded?.actionType).toBe('SetMaxDiscountRate');
      expect(decoded?.proposedValue).toBe(250n);
      expect(decoded?.votesFor).toBe(10000n);
      expect(decoded?.votesAgainst).toBe(1500n);
      expect(decoded?.ledger).toBe(2000);
      expect(decoded?.txHash).toBe('02'.repeat(32));
    });

    it('handles malformed value payloads', () => {
      const malformed = createRawEventFixture(
        GOV,
        [
          nativeToScVal('proposal_executed', { type: 'symbol' }),
          nativeToScVal(10n, { type: 'u64' }),
        ],
        nativeToScVal('not a struct')
      );

      expect(decodeProposalExecutedEvent(malformed)).toBeNull();
      expect(() => decodeProposalExecutedEvent(malformed, { strict: true })).toThrow(
        EventDecodingError
      );
    });
  });

  describe('decodeVoteCastEvent', () => {
    it('decodes For, Against, and Abstain vote fixtures deterministically', () => {
      const choices: Array<'For' | 'Against' | 'Abstain'> = ['For', 'Against', 'Abstain'];

      for (const choice of choices) {
        const fixture = createVoteCastFixture(GOV, 7, VOTER, choice, 5000, {
          ledger: 3000,
          txHash: '03'.repeat(32),
        });

        const decoded = decodeVoteCastEvent(fixture);
        expect(decoded).not.toBeNull();
        expect(decoded?.kind).toBe('vote_cast');
        expect(decoded?.proposalId).toBe(7);
        expect(decoded?.voter).toBe(VOTER);
        expect(decoded?.choice).toBe(choice);
        expect(decoded?.votingPower).toBe(5000n);
        expect(decoded?.ledger).toBe(3000);
      }
    });

    it('rejects negative or malformed voting power', () => {
      const malformed = createRawEventFixture(
        GOV,
        [
          nativeToScVal('vote_cast', { type: 'symbol' }),
          nativeToScVal(7n, { type: 'u64' }),
          nativeToScVal(VOTER, { type: 'address' }),
        ],
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: nativeToScVal('voting_power', { type: 'symbol' }),
            val: nativeToScVal(-500n, { type: 'i128' }),
          }),
        ])
      );

      expect(decodeVoteCastEvent(malformed)).toBeNull();
      expect(() => decodeVoteCastEvent(malformed, { strict: true })).toThrow(
        EventDecodingError
      );
    });

    it('rejects missing voter address in strict mode', () => {
      const malformed = createRawEventFixture(
        GOV,
        [
          nativeToScVal('vote_cast', { type: 'symbol' }),
          nativeToScVal(7n, { type: 'u64' }),
        ],
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: nativeToScVal('voting_power', { type: 'symbol' }),
            val: nativeToScVal(100n, { type: 'i128' }),
          }),
        ])
      );

      expect(decodeVoteCastEvent(malformed)).toBeNull();
      expect(() => decodeVoteCastEvent(malformed, { strict: true })).toThrow(
        EventDecodingError
      );
    });
  });

  describe('decodeProposalVetoedEvent', () => {
    it('decodes a valid proposal_vetoed event fixture', () => {
      const reasonHash = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
      const fixture = createProposalVetoedFixture(GOV, 15, ADMIN, reasonHash, {
        ledger: 4000,
        txHash: '04'.repeat(32),
      });

      const decoded = decodeProposalVetoedEvent(fixture);
      expect(decoded).not.toBeNull();
      expect(decoded?.kind).toBe('proposal_vetoed');
      expect(decoded?.proposalId).toBe(15);
      expect(decoded?.admin).toBe(ADMIN);
      expect(decoded?.reasonHash).toBe(reasonHash);
      expect(decoded?.ledger).toBe(4000);
      expect(decoded?.txHash).toBe('04'.repeat(32));
    });

    it('rejects proposal_vetoed when reason_hash is missing', () => {
      const malformed = createRawEventFixture(
        GOV,
        [
          nativeToScVal('proposal_vetoed', { type: 'symbol' }),
          nativeToScVal(15n, { type: 'u64' }),
          nativeToScVal(ADMIN, { type: 'address' }),
        ],
        xdr.ScVal.scvMap([])
      );

      expect(decodeProposalVetoedEvent(malformed)).toBeNull();
      expect(() => decodeProposalVetoedEvent(malformed, { strict: true })).toThrow(
        EventDecodingError
      );
    });
  });

  describe('decodeParameterUpdatedEvent', () => {
    it('decodes a valid parameter_updated event fixture', () => {
      const fixture = createParameterUpdatedFixture(GOV, 'fee_rate', 10, 20, ADMIN, {
        ledger: 5000,
        txHash: '05'.repeat(32),
      });

      const decoded = decodeParameterUpdatedEvent(fixture);
      expect(decoded).not.toBeNull();
      expect(decoded?.kind).toBe('parameter_updated');
      expect(decoded?.parameter).toBe('fee_rate');
      expect(decoded?.oldValue).toBe(10n);
      expect(decoded?.newValue).toBe(20n);
      expect(decoded?.updatedBy).toBe(ADMIN);
      expect(decoded?.ledger).toBe(5000);
      expect(decoded?.txHash).toBe('05'.repeat(32));
    });

    it('rejects parameter_updated missing new_value', () => {
      const malformed = createRawEventFixture(
        GOV,
        [
          nativeToScVal('parameter_updated', { type: 'symbol' }),
          nativeToScVal('fee_rate', { type: 'symbol' }),
        ],
        xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: nativeToScVal('old_value', { type: 'symbol' }),
            val: nativeToScVal(10n, { type: 'i128' }),
          }),
        ])
      );

      expect(decodeParameterUpdatedEvent(malformed)).toBeNull();
      expect(() => decodeParameterUpdatedEvent(malformed, { strict: true })).toThrow(
        EventDecodingError
      );
    });
  });

  describe('decodeGovernanceEvent universal router', () => {
    it('routes proposal_created, proposal_executed, vote_cast, proposal_vetoed, parameter_updated', () => {
      const e1 = createProposalCreatedFixture(GOV, 1, VOTER);
      const e2 = createProposalExecutedFixture(GOV, 2);
      const e3 = createVoteCastFixture(GOV, 3, VOTER, 'Against');
      const e4 = createProposalVetoedFixture(GOV, 4, ADMIN, '0xreason');
      const e5 = createParameterUpdatedFixture(GOV, 'quorum', 500, 600);

      expect(decodeGovernanceEvent(e1)?.kind).toBe('proposal_created');
      expect(decodeGovernanceEvent(e2)?.kind).toBe('proposal_executed');
      expect(decodeGovernanceEvent(e3)?.kind).toBe('vote_cast');
      expect(decodeGovernanceEvent(e4)?.kind).toBe('proposal_vetoed');
      expect(decodeGovernanceEvent(e5)?.kind).toBe('parameter_updated');
    });

    it('returns null on unrecognized event topics without throwing', () => {
      const unknownEvent = createRawEventFixture(
        GOV,
        [nativeToScVal('some_unrelated_event', { type: 'symbol' })],
        nativeToScVal(0)
      );

      expect(decodeGovernanceEvent(unknownEvent)).toBeNull();
    });

    it('regression guard: does not return fabricated fallback values on malformed input', () => {
      const corrupted = {
        topic: null,
        value: null,
      } as unknown as rpc.Api.EventResponse;

      expect(decodeGovernanceEvent(corrupted)).toBeNull();
    });
  });
});
