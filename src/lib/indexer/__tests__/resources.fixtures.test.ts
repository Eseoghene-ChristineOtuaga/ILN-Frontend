import { describe, expect, it } from 'vitest';
import {
  INDEXER_RESOURCE_NAMES,
  malformedIndexerPayloads,
  validIndexerPayloads,
} from '@/mocks/fixtures/indexer';
import { IndexerError } from '../errors';
import { INDEXER_RESOURCES } from '../resources';

function parserFor(name: string) {
  const resource = INDEXER_RESOURCES.find((r) => r.name === name);
  if (!resource) throw new Error(`no resource ${name}`);
  return resource.parse;
}

describe('indexer resource parsers × fixture catalogue', () => {
  it('covers every registered resource', () => {
    expect(INDEXER_RESOURCES.map((r) => r.name).sort()).toEqual([...INDEXER_RESOURCE_NAMES].sort());
    for (const name of INDEXER_RESOURCE_NAMES) {
      expect(
        malformedIndexerPayloads.some((f) => f.resource === name && f.expect.kind === 'schema')
      ).toBe(true);
      expect(
        malformedIndexerPayloads.some((f) => f.resource === name && f.expect.kind === 'partial')
      ).toBe(true);
    }
  });

  it.each(INDEXER_RESOURCE_NAMES)('accepts the valid %s payload without drops', (name) => {
    const { records, dropped } = parserFor(name)(validIndexerPayloads[name]);
    expect(dropped).toBe(0);
    expect(records.length).toBeGreaterThan(0);
  });

  it.each(malformedIndexerPayloads.map((f) => [f.name, f] as const))('%s', (_name, fixture) => {
    const parse = parserFor(fixture.resource);
    if (fixture.expect.kind === 'schema') {
      let caught: unknown;
      try {
        parse(fixture.body);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(IndexerError);
      expect((caught as IndexerError).code).toBe('schema');
      return;
    }
    const { records, dropped } = parse(fixture.body);
    expect({ kept: records.length, dropped }).toEqual({
      kept: fixture.expect.kept,
      dropped: fixture.expect.dropped,
    });
  });

  it('never invents values for kept partial records', () => {
    const fixture = malformedIndexerPayloads.find((f) => f.name === 'events: partial records')!;
    const { records } = parserFor('invoice.events')(fixture.body);
    for (const record of records as Array<Record<string, unknown>>) {
      expect(typeof record.timestamp).toBe('number');
      expect(record.timestamp).toBeLessThan(Date.now());
      expect(['paid']).toContain(record.type);
    }
  });

  it('does not let leaderboard rows pollute prototypes or carry non-numeric metrics', () => {
    const body = JSON.parse(
      '[{"address":"GAAA","__proto__":{"polluted":1},"constructor":{"x":1},"score":"99","rank":2}]'
    );
    const { records } = parserFor('leaderboard')(body);
    expect(records).toEqual([{ address: 'GAAA', rank: 2 }]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
