/**
 * Guards the browser-safe subpath (#2643, #2647): `src/browser.ts` and every
 * relative module it reaches must not import Node built-ins or `next/*`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as browser from '../src/browser';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const FORBIDDEN = /^(node:.*|fs|fs\/promises|crypto|path|os|child_process|next|next\/.*)$/;
const IMPORT_RE = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;

function collectSpecifiers(file: string, seen = new Set<string>()): string[] {
  if (seen.has(file)) return [];
  seen.add(file);
  const source = readFileSync(file, 'utf8');
  const specs: string[] = [];
  for (const m of source.matchAll(IMPORT_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    specs.push(spec);
    if (spec.startsWith('.')) {
      const base = resolve(dirname(file), spec);
      const target = [`${base}.ts`, resolve(base, 'index.ts')].find(existsSync);
      if (target) specs.push(...collectSpecifiers(target, seen));
    }
  }
  return specs;
}

describe('browser entry', () => {
  it('exports requestAppToken', () => {
    expect(typeof browser.requestAppToken).toBe('function');
  });

  it('does not reach Node built-ins or next/* imports', () => {
    const specs = collectSpecifiers(resolve(SRC, 'browser.ts'));
    expect(specs.filter((s) => FORBIDDEN.test(s))).toEqual([]);
  });
});
