import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DELEGATION_ROUTES } from '../src/delegation-policy';

/**
 * #2360 uniformity guard. The policy is only "blanket" if it can't silently
 * rot: every registered route must really call the helper, and no route may
 * call the helper with a key the registry doesn't know. A registered route
 * that drops its call, a typo'd key, or a copy-pasted key (two handlers
 * sharing one registry entry) all fail here.
 *
 * A `reversible` route needs no enforcement (a delegate may execute it), so its
 * call is optional — but if one is present it must still be unique. Flipping a
 * route to `irreversible` / `value-moving` in the registry makes the call
 * mandatory, so a class change can never silently go unenforced.
 */

const REPO_ROOT = resolve(__dirname, '../../..');
const APPS_DIR = join(REPO_ROOT, 'apps');
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '__tests__']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

/** Every `enforceRoutePolicy(...)` / `mediaDelegationGate(...)` call site → the registry key it names. */
const CALL_PATTERN = /(?:enforceRoutePolicy|mediaDelegationGate)\([^;]*?["']((?:[a-z-]+\.)+[a-z-]+)["']/g;

function collectCallSites(): Map<string, string[]> {
  const sites = new Map<string, string[]>();
  for (const app of readdirSync(APPS_DIR)) {
    const appDir = join(APPS_DIR, app);
    if (!statSync(appDir).isDirectory()) continue;
    for (const sub of ['app', 'src']) {
      const root = join(appDir, sub);
      if (!existsSync(root)) continue;
      for (const file of walk(root)) {
        const src = readFileSync(file, 'utf8');
        for (const match of src.matchAll(CALL_PATTERN)) {
          const key = match[1];
          sites.set(key, [...(sites.get(key) ?? []), file.slice(REPO_ROOT.length + 1)]);
        }
      }
    }
  }
  return sites;
}

const callSites = collectCallSites();
const entries = Object.entries(DELEGATION_ROUTES);

describe('delegation policy coverage (#2360)', () => {
  it('finds call sites at all (guards the scan itself)', () => {
    expect(callSites.size).toBeGreaterThan(30);
  });

  it.each(entries)('%s is enforced by exactly one handler (reversible: at most one)', (key, entry) => {
    const count = callSites.get(key)?.length ?? 0;
    if (entry.class === 'reversible') {
      expect(count).toBeLessThanOrEqual(1);
    } else {
      expect(count).toBe(1);
    }
  });

  it.each(entries)('%s points at a real route handler', (key, entry) => {
    const file = join(APPS_DIR, entry.app, 'app', entry.path, 'route.ts');
    expect(existsSync(file)).toBe(true);
    const src = readFileSync(file, 'utf8');
    const exportsMethod = new RegExp(
      String.raw`export\s+(?:async\s+function\s+${entry.method}\b|const\s+${entry.method}\b|\{[^}]*\b${entry.method}\b)`,
    );
    expect(exportsMethod.test(src)).toBe(true);
  });

  it('has no call site naming an unregistered key', () => {
    const unknown = [...callSites.keys()].filter((key) => !(key in DELEGATION_ROUTES));
    expect(unknown).toEqual([]);
  });
});
