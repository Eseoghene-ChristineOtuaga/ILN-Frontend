import { afterAll, afterEach, beforeAll, vi } from 'vitest';
import '@testing-library/jest-dom';
import type { Usable } from 'react';
import { configure } from '@testing-library/react';
import { toHaveNoViolations } from 'jest-axe';
import { server } from './src/mocks/server';

// Vitest provides a global `expect` in tests; declare it for TypeScript here.
declare const expect: any;

// Extend expect with jest-axe matchers
expect.extend(toHaveNoViolations);

// Testing Library's default waitFor/findBy timeout is 1000ms, which is too
// tight once the process is under heavy CPU load - e.g. the CI/coverage job's
// `--coverage.include=src/**` glob instruments most of the codebase and can
// starve pending promises well past 1s. Matches the testTimeout/hookTimeout
// headroom in vitest.config.ts.
configure({ asyncUtilTimeout: 5_000 });

// Mock ResizeObserver for recharts / other components that use it
class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

// Files that opt into `@vitest-environment node` (e.g. route-handler tests)
// have no DOM, so the browser-only shims below are applied conditionally.
const hasDom = typeof window !== 'undefined';

// Mock matchMedia for testing components that use prefers-reduced-motion
if (hasDom) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(), // deprecated
      removeListener: vi.fn(), // deprecated
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

// Mock react-query
vi.mock('@tanstack/react-query', () => ({
  useQuery: vi.fn(() => ({
    data: [],
    isLoading: false,
    error: null,
    dataUpdatedAt: Date.now(),
    refetch: vi.fn(),
  })),
  useMutation: vi.fn(() => ({
    mutate: vi.fn(),
    isPending: false,
  })),
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
    cancelQueries: vi.fn(),
    setQueryData: vi.fn(),
    getQueryData: vi.fn(),
  })),
  QueryClient: vi.fn(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  QueryClientProvider: ({ children }: { children: any }) => children,
}));

// Mock @stellar/freighter-api. The real implementation races a postMessage
// against a 2s setTimeout fallback (see its `isConnected`/`getAddress`
// internals) waiting for a browser extension that doesn't exist in jsdom.
// Any test that renders the real WalletContext without mocking it (e.g.
// i18n.test.tsx) leaves that timer pending past the test's own duration;
// when it eventually fires, `window` may already be torn down by a later
// test file's environment, throwing "ReferenceError: window is not defined"
// as an unhandled error attributed to whatever happens to be running then.
// Test files that need specific wallet behavior already override this with
// their own vi.mock('@stellar/freighter-api', ...), which takes precedence.
vi.mock('@stellar/freighter-api', () => ({
  isConnected: vi.fn().mockResolvedValue({ isConnected: false }),
  getAddress: vi.fn().mockResolvedValue({ address: '' }),
  setAllowed: vi.fn().mockResolvedValue({ isAllowed: false }),
  signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: '' }),
  getNetwork: vi.fn().mockResolvedValue({ network: 'TESTNET', networkPassphrase: '' }),
  requestAccess: vi.fn().mockResolvedValue({ address: '' }),
}));

// Mock next/navigation
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  })),
  usePathname: vi.fn(() => '/'),
  useSearchParams: vi.fn(() => new URLSearchParams()),
  useParams: vi.fn(() => ({})),
}));

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    clear: () => {
      store = {};
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    get length() {
      return Object.keys(store).length;
    },
    key: (index: number) => Object.keys(store)[index] || null,
  };
})();

if (hasDom) {
  Object.defineProperty(window, 'localStorage', { value: localStorageMock });
}
Object.defineProperty(global, 'localStorage', { value: localStorageMock });

// Mock react 'use' hook for Next.js params
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    use: vi.fn(<T>(input: Usable<T>): T => {
      if (
        typeof input === 'object' &&
        input !== null &&
        'then' in input &&
        typeof input.then === 'function'
      ) {
        const resolvedValue = '_resolvedValue' in input ? input._resolvedValue : undefined;
        if (resolvedValue !== undefined) return resolvedValue as T;
        return input as T;
      }
      return actual.use(input);
    }),
  };
});

// Initialize i18n (browser-only: the language detector needs a DOM)
if (hasDom) {
  await import('./src/i18n');
}

beforeAll(() => server.listen({ onUnhandledRequest: 'warn' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
