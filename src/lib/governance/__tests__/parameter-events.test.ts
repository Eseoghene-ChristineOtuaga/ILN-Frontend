/**
 * Parameter-change announcements come from confirmed contract events (#1057).
 */
import { describe, expect, it, vi } from 'vitest';
import { Contract, nativeToScVal, rpc, xdr } from '@stellar/stellar-sdk';
import {
  DEFAULT_LOOKBACK_LEDGERS,
  ParameterEventsError,
  fetchConfirmedParameterUpdates,
  formatParameterValue,
  latestParameterValues,
} from '../parameter-events';

const GOV = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';
const PROTOCOL = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75';
const TOKEN = 'CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA';
const ADMIN = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';

const sym = (s: string) => nativeToScVal(s, { type: 'symbol' });
const i128 = (n: number) => nativeToScVal(BigInt(n), { type: 'i128' });

function struct(fields: Record<string, xdr.ScVal>): xdr.ScVal {
  return xdr.ScVal.scvMap(
    Object.keys(fields)
      .sort()
      .map((key) => new xdr.ScMapEntry({ key: sym(key), val: fields[key] }))
  );
}

function event(
  contractId: string,
  topic: xdr.ScVal[],
  value: xdr.ScVal,
  meta: { ledger: number; txHash: string; ok?: boolean }
): rpc.Api.EventResponse {
  return {
    id: `${meta.ledger}-${meta.txHash}`,
    type: 'contract',
    ledger: meta.ledger,
    ledgerClosedAt: new Date(meta.ledger * 5_000).toISOString(),
    transactionIndex: 0,
    operationIndex: 0,
    inSuccessfulContractCall: meta.ok ?? true,
    txHash: meta.txHash,
    contractId: new Contract(contractId),
    topic,
    value,
  } as unknown as rpc.Api.EventResponse;
}

function protocolParamUpdate(
  name: string,
  oldV: number,
  newV: number,
  ledger: number,
  txHash: string
) {
  return event(
    PROTOCOL,
    [sym('parameter_updated'), sym(name), nativeToScVal(ADMIN, { type: 'address' })],
    struct({
      param_name: sym(name),
      old_value: i128(oldV),
      new_value: i128(newV),
      updated_by: nativeToScVal(ADMIN, { type: 'address' }),
    }),
    { ledger, txHash }
  );
}

function proposalExecuted(id: number, action: xdr.ScVal, ledger: number, txHash: string) {
  return event(
    GOV,
    [sym('proposal_executed'), nativeToScVal(BigInt(id), { type: 'u64' })],
    struct({
      proposal_id: nativeToScVal(BigInt(id), { type: 'u64' }),
      action_type: action,
      proposed_value: i128(0),
      votes_for: i128(10),
      votes_against: i128(1),
    }),
    { ledger, txHash }
  );
}

function fakeServer(pages: rpc.Api.EventResponse[][], latest = 100_000) {
  const getEvents = vi.fn();
  pages.forEach((events, index) =>
    getEvents.mockResolvedValueOnce({ events, cursor: `c${index}`, latestLedger: latest })
  );
  return {
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: latest }),
    getEvents,
  };
}

describe('fetchConfirmedParameterUpdates', () => {
  it('links protocol changes to the proposal executed in the same transaction', async () => {
    const server = fakeServer([
      [
        proposalExecuted(
          9,
          xdr.ScVal.scvVec([sym('UpdateFeeRate'), nativeToScVal(20, { type: 'u32' })]),
          900,
          'aa'
        ),
        protocolParamUpdate('protocol_fee_rate_bps', 30, 20, 900, 'aa'),
        protocolParamUpdate('max_discount_rate_bps', 500, 400, 950, 'bb'),
      ],
    ]);

    const result = await fetchConfirmedParameterUpdates({
      server: server as never,
      governanceContractId: GOV,
      protocolContractId: PROTOCOL,
    });

    expect(result.scannedFromLedger).toBe(100_000 - DEFAULT_LOOKBACK_LEDGERS);
    expect(result.events.map((e) => [e.parameter, e.proposalId, e.newValue, e.oldValue])).toEqual([
      ['max_discount_rate_bps', null, '400 (4%)', '500 (5%)'],
      ['protocol_fee_rate_bps', 9, '20 (0.2%)', '30 (0.3%)'],
    ]);
    expect(result.events[1]).toMatchObject({
      id: 'aa:protocol_fee_rate_bps',
      txHash: 'aa',
      ledger: 900,
      source: 'protocol',
      rawNewValue: 20n,
      updatedAt: 4_500,
    });

    // Topic filters target the contracts' real event names.
    const [{ filters }] = server.getEvents.mock.calls[0];
    expect(filters).toHaveLength(3);
    expect(filters[0].contractIds).toEqual([GOV]);
    expect(filters[1].contractIds).toEqual([PROTOCOL]);
    expect(filters[0].topics[0][0]).toBe(sym('parameter_updated').toXDR('base64'));
    expect(filters[2].topics[0][0]).toBe(sym('proposal_executed').toXDR('base64'));
  });

  it('announces token allowlist changes from executed AddToken/RemoveToken proposals', async () => {
    const add = xdr.ScVal.scvVec([
      sym('AddToken'),
      nativeToScVal(TOKEN, { type: 'address' }),
      nativeToScVal(7, { type: 'u32' }),
    ]);
    const server = fakeServer([[proposalExecuted(3, add, 500, 'cc')]]);
    const { events } = await fetchConfirmedParameterUpdates({
      server: server as never,
      governanceContractId: GOV,
      protocolContractId: PROTOCOL,
    });
    expect(events).toEqual([
      expect.objectContaining({
        parameter: 'accepted_tokens',
        proposalId: 3,
        newValue: `Added ${TOKEN}`,
        rawNewValue: null,
      }),
    ]);
  });

  it('ignores events from failed contract calls', async () => {
    const failed = protocolParamUpdate('protocol_fee_rate_bps', 30, 99, 700, 'dd');
    (failed as { inSuccessfulContractCall: boolean }).inSuccessfulContractCall = false;
    const server = fakeServer([[failed]]);
    const { events } = await fetchConfirmedParameterUpdates({
      server: server as never,
      governanceContractId: GOV,
      protocolContractId: PROTOCOL,
    });
    expect(events).toEqual([]);
  });

  it('paginates with the cursor while pages are full', async () => {
    const full = Array.from({ length: 200 }, (_, i) =>
      protocolParamUpdate('protocol_fee_rate_bps', 1, i + 2, 1_000 + i, `t${i}`)
    );
    const server = fakeServer([
      full,
      [protocolParamUpdate('max_discount_rate_bps', 1, 2, 2_000, 'last')],
    ]);
    const { events } = await fetchConfirmedParameterUpdates({
      server: server as never,
      governanceContractId: GOV,
      protocolContractId: PROTOCOL,
    });
    expect(events).toHaveLength(201);
    expect(server.getEvents).toHaveBeenCalledTimes(2);
    expect(server.getEvents.mock.calls[1][0]).toMatchObject({ cursor: 'c0' });
  });

  it('rescans from the oldest retained ledger when the lookback exceeds retention', async () => {
    const server = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100_000 }),
      getEvents: vi
        .fn()
        .mockRejectedValueOnce(
          new Error(
            'startLedger must be between the oldest ledger: 90000 and the latest ledger: 100000'
          )
        )
        .mockResolvedValueOnce({ events: [], cursor: '', latestLedger: 100_000 }),
    };
    const result = await fetchConfirmedParameterUpdates({
      server: server as never,
      governanceContractId: GOV,
      protocolContractId: PROTOCOL,
      lookbackLedgers: 50_000,
    });
    expect(result.scannedFromLedger).toBe(90_000);
    expect(server.getEvents.mock.calls[1][0]).toMatchObject({ startLedger: 90_000 });
  });

  it('throws a typed error instead of falling back when RPC is unavailable', async () => {
    const down = {
      getLatestLedger: vi.fn().mockRejectedValue(new Error('offline')),
      getEvents: vi.fn(),
    };
    await expect(
      fetchConfirmedParameterUpdates({
        server: down as never,
        governanceContractId: GOV,
        protocolContractId: PROTOCOL,
      })
    ).rejects.toBeInstanceOf(ParameterEventsError);

    const eventsDown = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 10 }),
      getEvents: vi.fn().mockRejectedValue(new Error('500')),
    };
    await expect(
      fetchConfirmedParameterUpdates({
        server: eventsDown as never,
        governanceContractId: GOV,
        protocolContractId: PROTOCOL,
      })
    ).rejects.toThrow(/PARAMETER_EVENTS_UNAVAILABLE/);
  });
});

describe('latestParameterValues / formatParameterValue', () => {
  it('takes the newest confirmed value per parameter', () => {
    const latest = latestParameterValues([
      { parameter: 'protocol_fee_rate_bps', rawNewValue: 20n },
      { parameter: 'protocol_fee_rate_bps', rawNewValue: 30n },
      { parameter: 'accepted_tokens', rawNewValue: null },
    ] as never);
    expect([...latest]).toEqual([['protocol_fee_rate_bps', 20n]]);
  });

  it('formats values by unit', () => {
    expect(formatParameterValue('protocol_fee_rate_bps', 30n)).toBe('30 (0.3%)');
    expect(formatParameterValue('quadratic_voting_enabled', 0n)).toBe('Disabled');
    expect(formatParameterValue('execution_delay', 17_280n)).toBe('17280 ledgers');
    expect(formatParameterValue('min_proposal_balance', 5n)).toBe('5');
  });
});
