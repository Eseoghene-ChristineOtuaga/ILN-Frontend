import type { NextConfig } from 'next';
import withPWA from 'next-pwa';
import { withSentryConfig } from '@sentry/nextjs';
import { assertNoPublicIndexerSecrets } from './src/lib/indexer/env-guard';

// Fail the build before Next.js can inline an indexer credential into browser bundles.
assertNoPublicIndexerSecrets();

const nextConfig: NextConfig & { allowedDevOrigins?: string[] } = {
  reactStrictMode: true,
  turbopack: {},
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  // instrumentationHook moved out of experimental in Next 15+
  // (removing stale flag that caused TS2353; instrumentation.ts is still picked up automatically)
  experimental: {},
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Content-Security-Policy',
            value: `
              default-src 'self';
              script-src 'self' 'unsafe-inline' 'unsafe-eval' *.vercel.app;
              style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
              font-src 'self' https://fonts.gstatic.com;
              img-src 'self' data: https:;
              media-src 'self';
              connect-src 'self' https://stellar.expert https://horizon.stellar.org https://horizon-testnet.stellar.org https://rpc-futurenet.stellar.org https://soroban-rpc.stellar.org https://soroban-rpc.stellar.org https://*.supabase.co https://api.github.com;
              frame-ancestors 'none';
              object-src 'none';
              base-uri 'self';
              form-action 'self';
              upgrade-insecure-requests;
            `
              .replace(/\s+/g, ' ')
              .trim(),
          },
          {
            key: 'X-Content-Type-Options',
            value: 'nosniff',
          },
          {
            key: 'X-Frame-Options',
            value: 'DENY',
          },
          {
            key: 'Referrer-Policy',
            value: 'strict-origin-when-cross-origin',
          },
          {
            key: 'Permissions-Policy',
            value: 'geolocation=(), microphone=(), camera=()',
          },
        ],
      },
      {
        // RFC 9116 recommends serving security.txt as text/plain.
        source: '/.well-known/security.txt',
        headers: [
          {
            key: 'Content-Type',
            value: 'text/plain; charset=utf-8',
          },
        ],
      },
    ];
  },
  async redirects() {
    return [
      {
        source: '/dashboard/payer',
        destination: '/payer',
        permanent: true,
      },
      {
        source: '/analytics/freelancer',
        destination: '/analytics',
        permanent: true,
      },
      {
        source: '/analytics/leaderboard',
        destination: '/leaderboard',
        permanent: true,
      },
      {
        // Excludes "batch", which is a real static route (app/invoices/batch)
        // rather than an invoice id - without this, it would be redirected to
        // /i/batch and crash trying to parse "batch" as an invoice id.
        source: '/invoices/:id((?!batch$).*)',
        destination: '/i/:id',
        permanent: true,
      },
    ];
  },
};

const pwaWrapped = withPWA({
  dest: 'public',
  register: true,
  skipWaiting: true,
  // Paired with skipWaiting so a newly-installed SW takes control of already
  // open tabs immediately, rather than leaving them on a stale worker until
  // the next full reload. See "Service Worker Security Model" in
  // docs/architecture.md for the full threat-model writeup.
  clientsClaim: true,
  fallbacks: {
    document: '/offline',
  },
  runtimeCaching: [
    {
      urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
      handler: 'CacheFirst',
      options: {
        cacheName: 'google-fonts',
        cacheableResponse: { statuses: [0, 200] },
        expiration: {
          maxEntries: 4,
          maxAgeSeconds: 365 * 24 * 60 * 60, // 365 days
        },
      },
    },
    {
      urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
      handler: 'CacheFirst',
      options: {
        cacheName: 'google-fonts-static',
        cacheableResponse: { statuses: [0, 200] },
        expiration: {
          maxEntries: 4,
          maxAgeSeconds: 365 * 24 * 60 * 60, // 365 days
        },
      },
    },
    {
      urlPattern: /\.(?:js|css|woff|woff2|ttf|eot)$/i,
      handler: 'StaleWhileRevalidate',
      options: {
        cacheName: 'static-assets',
        cacheableResponse: { statuses: [0, 200] },
        expiration: {
          maxEntries: 64,
          maxAgeSeconds: 24 * 60 * 60, // 24 hours
        },
      },
    },
    {
      urlPattern: /\/api\/.*$/i,
      handler: 'NetworkFirst',
      options: {
        cacheName: 'api-cache',
        // Only cache clean same-origin (0 = opaque no-cors, kept for parity
        // with other entries) and 200 responses - error bodies and redirects
        // must never be persisted as if they were valid API responses.
        cacheableResponse: { statuses: [0, 200] },
        expiration: {
          maxEntries: 16,
          maxAgeSeconds: 24 * 60 * 60, // 24 hours
        },
        networkTimeoutSeconds: 10,
      },
    },
    {
      urlPattern: ({ request }: any) => request.destination === 'document',
      handler: 'NetworkFirst',
      options: {
        cacheName: 'pages',
        cacheableResponse: { statuses: [0, 200] },
        expiration: {
          maxEntries: 32,
          maxAgeSeconds: 24 * 60 * 60, // 24 hours
        },
        networkTimeoutSeconds: 10,
      },
    },
  ],
})(nextConfig);

// Wrap with Sentry to enable source map upload at build time.
// Source maps are deleted from the Vercel CDN after upload (hideSourceMaps: true)
// so they are not publicly accessible. See docs/sentry-integration.md.
export default withSentryConfig(pwaWrapped, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  silent: !process.env.CI,
  sourcemaps: {
    deleteSourcemapsAfterUpload: true,
  },
  disableLogger: true,
});
