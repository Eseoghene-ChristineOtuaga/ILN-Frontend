import { afterEach, describe, expect, it, vi } from 'vitest';
import { IndexerError } from '../errors';
import {
  assertNoPublicIndexerSecrets,
  DEFAULT_INDEXER_TIMEOUT_MS,
  loadIndexerResource,
  readIndexerServerConfig,
  redactSecrets,
  requestIndexer,
  type IndexerServerConfig,
} from '../server';

const SECRET = 'sk_live_indexer_0123456789';
const ENV = { INDEXER_URL: 'https://indexer.internal.example/', INDEXER_API_KEY: SECRET };
const CONFIG: IndexerServerConfig = {
  baseUrl: 'https://indexer.internal.example',
  apiKey: SECRET,
  timeoutMs: 50,
  versionPolicy: 'strict',
  staleAfterMs: 300_000,
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'X-Indexer-Api-Version': '1.2.0' },
    ...init,
  });
}

async function captureError(promise: Promise<unknown>): Promise<IndexerError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(IndexerError);
    return err as IndexerError;
  }
  throw new Error('expected promise to reject');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readIndexerServerConfig', () => {
  it('reads server-only variables and normalises the base URL', () => {
    expect(readIndexerServerConfig({ ...ENV, INDEXER_TIMEOUT_MS: '2500' })).toEqual({
      baseUrl: 'https://indexer.internal.example',
      apiKey: SECRET,
      timeoutMs: 2500,
      versionPolicy: 'strict',
      staleAfterMs: 300_000,
    });
  });

  it('defaults and clamps the timeout', () => {
    expect(readIndexerServerConfig(ENV).timeoutMs).toBe(DEFAULT_INDEXER_TIMEOUT_MS);
    expect(readIndexerServerConfig({ ...ENV, INDEXER_TIMEOUT_MS: '5' }).timeoutMs).toBe(1000);
    expect(readIndexerServerConfig({ ...ENV, INDEXER_TIMEOUT_MS: '999999' }).timeoutMs).toBe(30000);
    expect(readIndexerServerConfig({ ...ENV, INDEXER_TIMEOUT_MS: 'abc' }).timeoutMs).toBe(
      DEFAULT_INDEXER_TIMEOUT_MS
    );
  });

  it('reports not_configured when the URL is missing or invalid', () => {
    for (const env of [{}, { INDEXER_URL: 'not a url' }, { INDEXER_URL: 'ftp://indexer' }]) {
      expect(() => readIndexerServerConfig(env)).toThrow(
        expect.objectContaining({ code: 'not_configured' })
      );
    }
  });

  it('falls back to the deprecated public URL with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const config = readIndexerServerConfig({
      NEXT_PUBLIC_INDEXER_API_URL: 'https://legacy.example',
    });
    expect(config.baseUrl).toBe('https://legacy.example');
    expect(config.apiKey).toBeNull();
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('refuses to run when a credential uses a NEXT_PUBLIC_ name', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => readIndexerServerConfig({ ...ENV, NEXT_PUBLIC_INDEXER_API_KEY: SECRET })).toThrow(
      expect.objectContaining({ code: 'not_configured' })
    );
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).toContain('NEXT_PUBLIC_INDEXER_API_KEY');
    expect(logged).not.toContain(SECRET);
  });
});

describe('assertNoPublicIndexerSecrets', () => {
  it.each([
    'NEXT_PUBLIC_INDEXER_API_KEY',
    'NEXT_PUBLIC_INDEXER_TOKEN',
    'NEXT_PUBLIC_ILN_INDEXER_SECRET',
    'next_public_indexer_auth',
  ])('rejects %s', (name) => {
    expect(() => assertNoPublicIndexerSecrets({ [name]: 'value' })).toThrow(name);
  });

  it('allows public non-secret indexer settings and empty values', () => {
    expect(() =>
      assertNoPublicIndexerSecrets({
        NEXT_PUBLIC_INDEXER_WS_URL: 'ws://localhost:8080/ws',
        NEXT_PUBLIC_INDEXER_API_KEY: '',
        INDEXER_API_KEY: SECRET,
      })
    ).not.toThrow();
  });

  it('never echoes the secret value in the error', () => {
    expect(() => assertNoPublicIndexerSecrets({ NEXT_PUBLIC_INDEXER_KEY: SECRET })).toThrow(
      expect.not.objectContaining({ message: expect.stringContaining(SECRET) })
    );
  });
});

describe('redactSecrets', () => {
  it('replaces every occurrence of each secret', () => {
    expect(redactSecrets(`a ${SECRET} b ${SECRET}`, [SECRET, null])).toBe(
      'a [redacted] b [redacted]'
    );
  });
});

describe('requestIndexer', () => {
  it('sends the bearer credential to the upstream only', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    await requestIndexer('/leaderboard?type=lp', CONFIG, { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://indexer.internal.example/leaderboard?type=lp');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(init.cache).toBe('no-store');
    expect(init.headers['Accept-Version']).toBe('1');
  });

  it('omits the Authorization header when no key is configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([]));
    await requestIndexer('/x', { ...CONFIG, apiKey: null }, { fetchImpl });
    expect(fetchImpl.mock.calls[0][1].headers).not.toHaveProperty('Authorization');
  });

  it.each([
    [401, 'unauthorized'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'upstream'],
    [504, 'timeout'],
  ])('maps upstream %i to %s', async (status, code) => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ detail: SECRET }, { status }));
    const err = await captureError(requestIndexer('/x', CONFIG, { fetchImpl }));
    expect(err.code).toBe(code);
    expect(err.message).not.toContain(SECRET);
  });

  it('times out with a typed error', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted')));
        })
    );
    const err = await captureError(requestIndexer('/x', CONFIG, { fetchImpl }));
    expect(err.code).toBe('timeout');
    expect(err.status).toBe(504);
  });

  it('redacts the credential and URL from network failure logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError(`connect failed ${CONFIG.baseUrl} with ${SECRET}`));
    const err = await captureError(requestIndexer('/x', CONFIG, { fetchImpl }));

    expect(err.code).toBe('network');
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).not.toContain(SECRET);
    expect(logged).not.toContain(CONFIG.baseUrl);
  });

  it('rejects non-JSON bodies as schema errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('<html>gateway</html>'));
    const err = await captureError(requestIndexer('/x', CONFIG, { fetchImpl }));
    expect(err.code).toBe('schema');
  });

  it('rejects oversized bodies', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('[]', { headers: { 'content-length': String(10 ** 8) } }));
    const err = await captureError(requestIndexer('/x', CONFIG, { fetchImpl }));
    expect(err.code).toBe('upstream');
  });
});

describe('loadIndexerResource', () => {
  it('returns a validated envelope for an allow-listed resource', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        jsonResponse([{ address: 'GAAA', metric1: 3, label: 'ignored-string' }, { metric1: 1 }])
      );
    const envelope = await loadIndexerResource(
      ['leaderboard'],
      new URLSearchParams('type=lp&period=30d&limit=10'),
      { fetchImpl, env: ENV }
    );

    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://indexer.internal.example/leaderboard?type=lp&period=30d&limit=10'
    );
    expect(envelope).toEqual({
      ok: true,
      resource: 'leaderboard',
      data: [{ address: 'GAAA', metric1: 3 }],
      meta: {
        apiVersion: '1.2.0',
        droppedRecords: 1,
        freshness: { lastIndexedLedger: null, lastIndexedAt: null, staleAfterMs: 300_000 },
      },
    });
  });

  it('rejects unknown resources before contacting the indexer', async () => {
    const fetchImpl = vi.fn();
    const err = await captureError(
      loadIndexerResource(['admin', 'keys'], new URLSearchParams(), { fetchImpl, env: ENV })
    );
    expect(err.code).toBe('unknown_resource');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects unexpected query parameters and values', async () => {
    const fetchImpl = vi.fn();
    for (const query of ['type=admin', 'limit=1000', 'period=30d&apiKey=x']) {
      const err = await captureError(
        loadIndexerResource(['leaderboard'], new URLSearchParams(query), { fetchImpl, env: ENV })
      );
      expect(err.code).toBe('bad_request');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports not_configured without contacting anything', async () => {
    const fetchImpl = vi.fn();
    const err = await captureError(
      loadIndexerResource(['leaderboard'], new URLSearchParams(), { fetchImpl, env: {} })
    );
    expect(err.code).toBe('not_configured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
