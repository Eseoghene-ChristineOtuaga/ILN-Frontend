import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLeaderboard } from '../leaderboard';

const fetchMock = vi.fn();
const originalFetch = global.fetch;
const VERSION = { 'X-Indexer-Api-Version': '1.0.0' };

describe('getLeaderboard', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubEnv('INDEXER_URL', 'https://indexer.iln.example.com');
    vi.stubEnv('INDEXER_API_KEY', 'sk_leaderboard_test');
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reads through the server-only indexer client and returns validated rows', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify([{ address: 'GADDR', amountFunded: 100 }, { amountFunded: 1 }]), {
        headers: VERSION,
      })
    );

    const result = await getLeaderboard('payer', '90d', 5);

    expect(result).toMatchObject({
      data: [{ address: 'GADDR', amountFunded: 100 }],
      unavailable: false,
      meta: { droppedRecords: 1, apiVersion: '1.0.0' },
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://indexer.iln.example.com/leaderboard?type=payer&period=90d&limit=5');
    expect(init.headers.Authorization).toBe('Bearer sk_leaderboard_test');
    expect(init.cache).toBe('no-store');
  });

  it('marks an empty leaderboard as empty, not unavailable', async () => {
    fetchMock.mockResolvedValue(new Response('[]', { headers: VERSION }));
    await expect(getLeaderboard('lp', '30d')).resolves.toMatchObject({
      data: [],
      unavailable: false,
      status: 'empty',
    });
  });

  it.each([
    [401, 'unauthorized', 'unauthorized'],
    [429, 'rate_limited', 'rate-limited'],
    [500, 'upstream', 'unavailable'],
  ])('reports HTTP %i as unavailable with code %s', async (status, code, boundary) => {
    fetchMock.mockResolvedValue(new Response('{}', { status }));
    await expect(getLeaderboard('lp', '30d')).resolves.toEqual({
      data: [],
      unavailable: true,
      status: boundary,
      code,
      error: expect.any(String),
    });
  });

  it('reports unavailable when the fetch throws (indexer down)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    await expect(getLeaderboard('lp', '30d')).resolves.toMatchObject({
      data: [],
      unavailable: true,
      code: 'network',
    });
  });

  it('reports malformed payloads and version drift as malformed', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"rows":[]}', { headers: VERSION }));
    await expect(getLeaderboard('lp', '30d')).resolves.toMatchObject({
      unavailable: true,
      status: 'malformed',
      code: 'schema',
    });

    fetchMock.mockResolvedValueOnce(
      new Response('[]', { headers: { 'X-Indexer-Api-Version': '2.0.0' } })
    );
    await expect(getLeaderboard('lp', '30d')).resolves.toMatchObject({
      unavailable: true,
      status: 'malformed',
      code: 'version_mismatch',
    });
  });

  it('reports a missing INDEXER_URL as not_configured instead of an empty leaderboard', async () => {
    vi.stubEnv('INDEXER_URL', '');
    const result = await getLeaderboard('lp', '30d');
    expect(result).toMatchObject({ data: [], unavailable: true, code: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
