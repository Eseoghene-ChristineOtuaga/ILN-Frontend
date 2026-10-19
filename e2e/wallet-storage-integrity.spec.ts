import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

/**
 * Wallet storage integrity, expiry and isolation in a real browser
 * (#1087, #1088, #1089, #1097).
 *
 * `WalletProvider` sweeps wallet-linked records on load
 * (`purgeExpiredWalletRecords` in `src/utils/walletRecordStore.ts`). This spec
 * seeds deterministic fixtures into the app origin's `localStorage`, reloads,
 * and checks that corrupt, tampered and expired records are gone while valid
 * records — including ones for another wallet or network — survive.
 *
 * Envelopes are built here with node:crypto using the same canonical digest
 * input as the app, so the spec also cross-checks the in-browser SHA-256.
 */

const TESTNET = 'Test SDF Network ; September 2015';
const PUBNET = 'Public Global Stellar Network ; September 2015';
const WALLET_A = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABC';
const WALLET_B = 'GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBD';
const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = 90 * DAY_MS;
const ENTRIES = [{ id: '1', address: WALLET_B, nickname: 'Bob' }];

const sha256 = (input: string) => createHash('sha256').update(input, 'utf8').digest('hex');

function recordKey(origin: string, network: string, wallet: string) {
  return `iln-address-book-v1-${sha256(`${origin}\n${network}`).slice(0, 12)}-${wallet}`;
}

function envelope(origin: string, network: string, wallet: string, savedAt: number) {
  const unsigned = {
    v: 1,
    kind: 'address-book',
    scope: { origin, network, wallet },
    savedAt,
    expiresAt: savedAt + RETENTION_MS,
    data: ENTRIES,
  };
  const digest = sha256(
    JSON.stringify([
      unsigned.v,
      unsigned.kind,
      origin,
      network,
      wallet,
      unsigned.savedAt,
      unsigned.expiresAt,
      unsigned.data,
    ])
  );
  return JSON.stringify({ ...unsigned, digest });
}

async function waitForHydration(page: Page) {
  await page.waitForFunction(
    () => {
      const nav = document.querySelector('nav');
      return nav && Object.keys(nav).some((k) => k.startsWith('__reactFiber'));
    },
    { timeout: 15000 }
  );
}

test.describe('Wallet storage integrity sweep', () => {
  test.slow();

  test('removes corrupt, tampered and expired records and keeps valid ones', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForHydration(page);
    const origin = new URL(page.url()).origin;
    const now = Date.now();

    const fixtures = {
      validA: [recordKey(origin, TESTNET, WALLET_A), envelope(origin, TESTNET, WALLET_A, now)],
      validOtherNetwork: [
        recordKey(origin, PUBNET, WALLET_A),
        envelope(origin, PUBNET, WALLET_A, now),
      ],
      expiredB: [
        recordKey(origin, TESTNET, WALLET_B),
        envelope(origin, TESTNET, WALLET_B, now - RETENTION_MS - DAY_MS),
      ],
      tampered: [
        'iln-address-book-v1-000000000000-GTAMPERED',
        envelope(origin, TESTNET, 'GTAMPERED', now).replace('"Bob"', '"Mallory"'),
      ],
      corrupt: ['iln-address-book-v1-000000000000-GCORRUPT', '{not json'],
    };

    await page.evaluate((entries) => {
      for (const [key, value] of entries) localStorage.setItem(key, value);
    }, Object.values(fixtures));

    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHydration(page);

    // Poll: the dev server can trigger a follow-up navigation after hydration.
    const keyNames = Object.keys(fixtures) as (keyof typeof fixtures)[];
    await expect
      .poll(async () => {
        const present = await page
          .evaluate(
            (keys) => keys.map((key) => localStorage.getItem(key) !== null),
            keyNames.map((name) => fixtures[name][0])
          )
          .catch(() => null);
        return present && Object.fromEntries(keyNames.map((name, i) => [name, present[i]]));
      })
      .toEqual({
        validA: true,
        validOtherNetwork: true,
        expiredB: false,
        tampered: false,
        corrupt: false,
      });
  });
});
