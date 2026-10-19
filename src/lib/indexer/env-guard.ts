/**
 * Build/runtime guard against shipping indexer credentials to the browser.
 *
 * Next.js inlines every `NEXT_PUBLIC_*` variable into client bundles at build
 * time, so an indexer key under that prefix is effectively public. This module
 * has no imports so `next.config.ts` can run it before the build starts.
 */

/** Matches public env var names that look like they hold an indexer credential. */
const PUBLIC_SECRET_NAME = /^NEXT_PUBLIC_.*INDEXER.*(KEY|TOKEN|SECRET|PASSWORD|AUTH)/i;

export function assertNoPublicIndexerSecrets(
  source: Record<string, string | undefined> = process.env
): void {
  const leaked = Object.keys(source).filter(
    (name) => PUBLIC_SECRET_NAME.test(name) && Boolean(source[name])
  );
  if (leaked.length > 0) {
    throw new Error(
      `Indexer credentials must not use the NEXT_PUBLIC_ prefix (it ships them to the browser): ` +
        `${leaked.join(', ')}. Rename to INDEXER_API_KEY.`
    );
  }
}
