import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexerError } from '../errors';
import { loadIndexerResource } from '../server';
import { negotiateIndexerVersion, parseIndexerApiVersion } from '../version';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('parseIndexerApiVersion', () => {
  it.each([
    ['1.4.2', { major: 1, minor: 4, patch: 2 }],
    ['v1.0', { major: 1, minor: 0, patch: 0 }],
    ['2.1.0-beta.1', { major: 2, minor: 1, patch: 0 }],
  ])('parses %s', (raw, expected) => {
    expect(parseIndexerApiVersion(raw)).toMatchObject(expected);
  });

  it.each([null, '', 'latest', '1', '1.x', 'one.two.three'])('rejects %s', (raw) => {
    expect(parseIndexerApiVersion(raw)).toBeNull();
  });
});

describe('negotiateIndexerVersion', () => {
  it('accepts compatible versions and normalises them', () => {
    expect(negotiateIndexerVersion('1.0.0')).toBe('1.0.0');
    expect(negotiateIndexerVersion('v1.7')).toBe('1.7.0');
  });

  it.each(['2.0.0', '0.9.3'])('rejects incompatible major version %s', (header) => {
    expect(() => negotiateIndexerVersion(header)).toThrow(
      expect.objectContaining({
        code: 'version_mismatch',
        message: expect.stringContaining('requires 1.x'),
      })
    );
  });

  it('rejects unparseable versions under every policy', () => {
    for (const policy of ['strict', 'allow-missing'] as const) {
      expect(() => negotiateIndexerVersion('banana', policy)).toThrow(IndexerError);
    }
  });

  it('rejects a missing version under the strict default', () => {
    expect(() => negotiateIndexerVersion(null)).toThrow(
      expect.objectContaining({ code: 'version_mismatch' })
    );
  });

  it('tolerates a missing version only under allow-missing, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(negotiateIndexerVersion(null, 'allow-missing')).toBe('unknown');
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('loadIndexerResource version enforcement', () => {
  const env = { INDEXER_URL: 'https://indexer.internal.example' };
  const driftedBody = [{ kind: 'funded', at: '2026-10-01T00:00:00Z' }];

  it('reports schema drift from a new major version as version_mismatch, not schema', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify(driftedBody), { headers: { 'X-Indexer-Api-Version': '2.0.0' } })
      );
    await expect(
      loadIndexerResource(['invoices', '1', 'events'], new URLSearchParams(), { fetchImpl, env })
    ).rejects.toMatchObject({ code: 'version_mismatch', status: 502 });
  });

  it('honours INDEXER_API_VERSION_POLICY=allow-missing', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([{ type: 'paid', timestamp: 1 }])));
    const envelope = await loadIndexerResource(['invoices', '1', 'events'], new URLSearchParams(), {
      fetchImpl,
      env: { ...env, INDEXER_API_VERSION_POLICY: 'allow-missing' },
    });
    expect(envelope.meta.apiVersion).toBe('unknown');
  });

  it('treats an unknown policy value as misconfiguration', async () => {
    const fetchImpl = vi.fn();
    await expect(
      loadIndexerResource(['leaderboard'], new URLSearchParams(), {
        fetchImpl,
        env: { ...env, INDEXER_API_VERSION_POLICY: 'off' },
      })
    ).rejects.toMatchObject({ code: 'not_configured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
