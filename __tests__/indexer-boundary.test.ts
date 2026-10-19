/**
 * Static guard for the indexer browser boundary (#1111).
 *
 * Walks the import graph from every `'use client'` module and asserts that no
 * browser-reachable code can read indexer credentials, import the server-only
 * indexer client, or call the upstream indexer directly.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIRS = ['app', 'src'];
const EXTENSIONS = ['.ts', '.tsx'];
const IGNORED = /(__tests__|\.test\.|\.spec\.|\.stories\.|[/\\]mocks[/\\]|[/\\]stories[/\\])/;

const FORBIDDEN_IN_BROWSER: Array<[RegExp, string]> = [
  [/process\.env(?:\.|\[['"])INDEXER_API_KEY\b/, 'reads the server-only indexer credential'],
  [/(?:import|export)[^;]*\bINDEXER_API_KEY\b/, 'imports the server-only indexer credential'],
  [/^\s*(?:export\s+)?const\s+INDEXER_API_KEY\b/m, 'defines the server-only indexer credential'],
  [/process\.env(?:\.|\[['"])INDEXER_URL\b/, 'reads the server-only indexer URL'],
  [/NEXT_PUBLIC_INDEXER_API_URL/, 'calls the indexer REST API directly instead of /api/indexer'],
  [/lib\/indexer\/server['"]/, 'imports the server-only indexer client'],
];

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listSourceFiles(full);
    return EXTENSIONS.includes(path.extname(entry.name)) ? [full] : [];
  });
}

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith('@/app/')) base = path.join(ROOT, 'app', specifier.slice(6));
  else if (specifier.startsWith('@/')) base = path.join(ROOT, 'src', specifier.slice(2));
  else if (specifier.startsWith('.')) base = path.resolve(path.dirname(from), specifier);
  else return null;

  const candidates = [
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => path.join(base, `index${ext}`)),
  ];
  return candidates.find((c) => fs.existsSync(c) && fs.statSync(c).isFile()) ?? null;
}

const IMPORT_PATTERN = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

function importsOf(file: string, source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    if (/^\s*(?:import|export)\s+type\s/.test(match[0])) continue; // erased at build time
    const resolved = resolveImport(file, match[1]);
    if (resolved) out.push(resolved);
  }
  return out;
}

function browserReachableFiles(): Set<string> {
  const files = SOURCE_DIRS.flatMap((d) => listSourceFiles(path.join(ROOT, d))).filter(
    (f) => !IGNORED.test(f)
  );
  const queue = files.filter((f) => /^\s*['"]use client['"]/.test(fs.readFileSync(f, 'utf8')));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file) || IGNORED.test(file)) continue;
    seen.add(file);
    queue.push(...importsOf(file, fs.readFileSync(file, 'utf8')));
  }
  return seen;
}

describe('indexer browser boundary', () => {
  const reachable = browserReachableFiles();

  it('finds the client modules that consume indexer data', () => {
    const rel = [...reachable].map((f) => path.relative(ROOT, f));
    expect(rel).toEqual(
      expect.arrayContaining([
        path.join('src', 'components', 'ActivityFeed.tsx'),
        path.join('src', 'components', 'charts', 'FundingChart.tsx'),
        path.join('src', 'lib', 'indexer-client.ts'),
      ])
    );
  });

  it('keeps indexer credentials and the server client out of browser code', () => {
    const violations: string[] = [];
    for (const file of reachable) {
      const source = fs.readFileSync(file, 'utf8');
      for (const [pattern, reason] of FORBIDDEN_IN_BROWSER) {
        if (pattern.test(source)) violations.push(`${path.relative(ROOT, file)} ${reason}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('never names an indexer credential with a NEXT_PUBLIC_ prefix in source', () => {
    const offenders = SOURCE_DIRS.flatMap((d) => listSourceFiles(path.join(ROOT, d)))
      .filter((f) => !IGNORED.test(f) && !f.endsWith(path.join('indexer', 'env-guard.ts')))
      .filter((f) =>
        /NEXT_PUBLIC_\w*INDEXER\w*(KEY|TOKEN|SECRET)/i.test(fs.readFileSync(f, 'utf8'))
      )
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
