import { expect, test } from '@playwright/test';

/**
 * Indexer browser boundary against the real Next.js server.
 * The e2e webServer runs without INDEXER_URL, so the proxy must fail closed
 * with a typed `not_configured` envelope rather than fabricate data.
 */
test.describe('Indexer browser boundary', () => {
  test.slow();

  test('proxy fails closed with a typed envelope when no indexer is configured', async ({
    request,
  }) => {
    const res = await request.get('/api/indexer/leaderboard?type=lp&period=all');
    expect(res.status()).toBe(503);
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(await res.json()).toEqual({
      ok: false,
      error: { code: 'not_configured', message: expect.any(String) },
    });
  });

  test('proxy rejects resources and parameters outside the allow-list', async ({ request }) => {
    const unknown = await request.get('/api/indexer/admin/keys');
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).error.code).toBe('unknown_resource');

    const badQuery = await request.get('/api/indexer/leaderboard?type=admin');
    expect(badQuery.status()).toBe(400);
    expect((await badQuery.json()).error.code).toBe('bad_request');
  });

  test('legacy leaderboard API reports typed failures instead of an empty list', async ({
    request,
  }) => {
    const res = await request.get('/api/leaderboard?type=lp&period=all');
    expect(res.status()).toBe(503);
    expect(await res.json()).toEqual({ error: expect.any(String), code: 'not_configured' });
  });

  test('invoice page loads indexer data only through the same-origin proxy', async ({ page }) => {
    const indexerRequests: string[] = [];
    page.on('request', (req) => {
      const url = new URL(req.url());
      if (url.pathname.includes('/events') || url.hostname.includes('indexer')) {
        indexerRequests.push(req.url());
      }
    });

    await page.goto('/i/1');
    await expect(page.getByText('Event History')).toBeVisible({ timeout: 60000 });
    // MSW serves an empty feed with no freshness headers: shown as unknown, not live.
    await expect(page.getByText('Indexer freshness unknown')).toBeVisible();

    expect(indexerRequests.length).toBeGreaterThan(0);
    for (const url of indexerRequests) {
      expect(new URL(url).origin).toBe(new URL(page.url()).origin);
      expect(new URL(url).pathname).toBe('/api/indexer/invoices/1/events');
    }
  });
});
