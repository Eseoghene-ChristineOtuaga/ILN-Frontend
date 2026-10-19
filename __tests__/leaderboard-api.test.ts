import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '../app/api/leaderboard/route';
import { getLeaderboard } from '@/lib/leaderboard';

vi.mock('@/lib/leaderboard', () => ({
  getLeaderboard: vi.fn(),
}));

let ipCounter = 0;

function makeRequest(query: string, ip?: string) {
  return new NextRequest(`http://localhost/api/leaderboard${query}`, {
    headers: { 'x-forwarded-for': ip ?? `10.4.0.${++ipCounter}` },
  });
}

describe('/api/leaderboard API route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns leaderboard data for valid query params', async () => {
    vi.mocked(getLeaderboard).mockResolvedValue({
      data: [{ address: 'GABC', score: 10 }],
      unavailable: false,
    });

    const response = await GET(makeRequest('?type=lp&period=30d&limit=10'));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual([{ address: 'GABC', score: 10 }]);
    expect(getLeaderboard).toHaveBeenCalledWith('lp', '30d', 10);
  });

  it('returns 503 (indexer unavailable) distinct from a generic error', async () => {
    vi.mocked(getLeaderboard).mockResolvedValue({ data: [], unavailable: true });

    const response = await GET(makeRequest('?type=lp&period=30d'));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({ error: 'Indexer temporarily unavailable' });
  });

  it('defaults type and period when omitted', async () => {
    vi.mocked(getLeaderboard).mockResolvedValue({ data: [], unavailable: false });

    const response = await GET(makeRequest(''));

    expect(response.status).toBe(200);
    expect(getLeaderboard).toHaveBeenCalledWith('lp', 'all', undefined);
  });

  describe('malformed and malicious input', () => {
    it('rejects an unrecognized leaderboard type', async () => {
      const response = await GET(makeRequest('?type=admin'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: 'Invalid leaderboard type' });
      expect(getLeaderboard).not.toHaveBeenCalled();
    });

    it('rejects a type containing script injection', async () => {
      const response = await GET(
        makeRequest(`?type=${encodeURIComponent('<script>alert(1)</script>')}`)
      );
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: 'Invalid leaderboard type' });
    });

    it('rejects an unrecognized period', async () => {
      const response = await GET(makeRequest('?period=1y'));
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body).toEqual({ error: 'Invalid leaderboard period' });
      expect(getLeaderboard).not.toHaveBeenCalled();
    });

    it.each([['-5'], ['0'], ['101'], ['abc']])(
      'rejects an invalid limit value (%s)',
      async (limit) => {
        const response = await GET(makeRequest(`?limit=${limit}`));
        const body = await response.json();

        expect(response.status).toBe(400);
        expect(body).toEqual({ error: 'Invalid limit' });
        expect(getLeaderboard).not.toHaveBeenCalled();
      }
    );
  });

  describe('indexer failures', () => {
    it.each([
      ['unauthorized', 502],
      ['timeout', 504],
      ['schema', 502],
      ['version_mismatch', 502],
      ['not_configured', 503],
    ] as const)('returns typed %s errors instead of an empty leaderboard', async (code, status) => {
      vi.mocked(getLeaderboard).mockResolvedValue({ data: [], unavailable: true, code });

      const response = await GET(makeRequest('?type=lp'));
      const body = await response.json();

      expect(response.status).toBe(status);
      expect(body).toEqual({ error: 'Indexer temporarily unavailable', code });
      expect(Array.isArray(body)).toBe(false);
    });

    it('hides unexpected failures behind a generic 500', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(getLeaderboard).mockRejectedValue(new Error('secret https://indexer.internal'));

      const response = await GET(makeRequest(''));
      const text = await response.text();

      expect(response.status).toBe(500);
      expect(text).not.toContain('indexer.internal');
      expect(spy.mock.calls.flat().join(' ')).not.toContain('indexer.internal');
      spy.mockRestore();
    });
  });

  describe('rate limiting', () => {
    it('returns 429 after exceeding the per-IP request limit', async () => {
      vi.mocked(getLeaderboard).mockResolvedValue({ data: [], unavailable: false });
      const ip = '203.0.113.40';

      for (let i = 0; i < 30; i += 1) {
        const response = await GET(makeRequest('', ip));
        expect(response.status).toBe(200);
      }

      const limited = await GET(makeRequest('', ip));
      expect(limited.status).toBe(429);
    });
  });
});
