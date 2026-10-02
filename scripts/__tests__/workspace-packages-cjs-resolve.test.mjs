import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression test for #2480: scripts/provision-service-bootstrap.ts is run via
// `pnpm exec tsx`, which compiles the (type-less, i.e. CJS) kernel sources to
// CJS. `import ... from '@imajin/vault-core'` therefore becomes a
// `require()`, and Node's CJS resolver fails with
// `No "exports" main defined` unless every conditional export has a
// `default` (or `require`) condition. This test exercises that resolver.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const packagesDir = join(repoRoot, 'packages');

/** Every @imajin/* workspace package that is ESM (`"type": "module"`) with a conditional exports map. */
function loadEsmPackages() {
  const result = [];
  for (const dir of readdirSync(packagesDir)) {
    const file = join(packagesDir, dir, 'package.json');
    if (!existsSync(file)) continue;
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    if (pkg.type !== 'module' || !pkg.name?.startsWith('@imajin/')) continue;
    if (!pkg.exports || typeof pkg.exports !== 'object') continue;
    result.push({ dir, pkg });
  }
  return result;
}

/** Flatten `exports` into [subpath, conditions] pairs, skipping plain-string targets. */
function conditionalEntries(exportsField) {
  return Object.entries(exportsField).filter(
    ([, value]) => value && typeof value === 'object',
  );
}

const esmPackages = loadEsmPackages();
const tmpRoots = [];

afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

describe('@imajin/* workspace packages are require()-resolvable (#2480)', () => {
  it('discovers workspace packages including the ones the kernel imports', () => {
    const names = esmPackages.map(({ pkg }) => pkg.name);
    for (const required of ['@imajin/vault-core', '@imajin/auth', '@imajin/bus', '@imajin/logger']) {
      expect(names).toContain(required);
    }
  });

  it('every conditional export has a "default" or "require" condition', () => {
    const offenders = [];
    for (const { pkg } of esmPackages) {
      for (const [subpath, conditions] of conditionalEntries(pkg.exports)) {
        if (!('default' in conditions) && !('require' in conditions)) {
          offenders.push(`${pkg.name} ${subpath}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('Node CJS resolver resolves every package subpath (stubbed dist, no build needed)', () => {
    const root = mkdtempSync(join(tmpdir(), 'cjs-resolve-test-'));
    tmpRoots.push(root);

    const subpaths = [];
    for (const { pkg } of esmPackages) {
      const pkgDir = join(root, 'node_modules', ...pkg.name.split('/'));
      mkdirSync(pkgDir, { recursive: true });
      // Copy the real manifest; create a stub file for every string target it references.
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg));
      const targets = JSON.stringify(pkg.exports).match(/"\.\/[^"]+"/g) ?? [];
      for (const quoted of targets) {
        const target = join(pkgDir, JSON.parse(quoted));
        if (!/\.(c|m)?js$/.test(target)) continue;
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, 'module.exports = {};\n');
      }
      for (const subpath of Object.keys(pkg.exports)) {
        subpaths.push(subpath === '.' ? pkg.name : `${pkg.name}/${subpath.slice(2)}`);
      }
    }

    const requireFromRoot = createRequire(join(root, 'index.cjs'));
    for (const specifier of subpaths) {
      expect(() => requireFromRoot.resolve(specifier), specifier).not.toThrow();
    }
  });

  it('kernel can require.resolve the packages the provisioning script imports', () => {
    const requireFromKernel = createRequire(join(repoRoot, 'apps', 'kernel', 'package.json'));
    for (const specifier of ['@imajin/vault-core', '@imajin/auth', '@imajin/bus', '@imajin/logger']) {
      let resolved;
      try {
        resolved = requireFromKernel.resolve(specifier);
      } catch (err) {
        // dist/ not built (or workspace not installed) is not a resolution-config bug.
        if (err?.code === 'MODULE_NOT_FOUND') continue;
        throw err;
      }
      expect(resolved).toMatch(/dist[\\/]index\.js$/);
    }
  });
});
