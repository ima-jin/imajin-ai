import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

// fileURLToPath, not `.pathname`: on Windows the latter yields "/D:/...",
// which node then resolves against the cwd into "C:\D:\..." and cannot load.
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WORKFLOW_PATH = join(REPO_ROOT, '.github/workflows/publish-packages.yml');
const PACKAGES_DIR = join(REPO_ROOT, 'packages');

/**
 * Regression guard for #2376: a `packages-v*` tag publishes exactly
 * `SDK_PACKAGES` (.github/workflows/publish-packages.yml) to GitHub
 * Packages. If any package in that list has a hard `@imajin/*` dependency
 * (a regular "dependencies" entry — npm always installs these, unlike a
 * peerDependency) on a package outside that list, a fresh `npm install` of
 * the published set fails with `ETARGET` (the sibling was never published).
 * That's exactly what happened the first time this list was used for a real
 * publish: `@imajin/ui` hard-depends on `@imajin/fair`, which wasn't in
 * `SDK_PACKAGES` (#2376). This walks every package.json under `packages/`
 * and fails if that gap reappears for any package in the list.
 */
function readSdkPackages() {
  const workflowYaml = readFileSync(WORKFLOW_PATH, 'utf8');
  const match = workflowYaml.match(/^\s*SDK_PACKAGES:\s*"([^"]+)"/m);
  if (!match) {
    throw new Error(`Could not find an "SDK_PACKAGES: \"...\"" line in ${WORKFLOW_PATH}`);
  }
  return match[1].trim().split(/\s+/).filter(Boolean);
}

/** The local (`@imajin/*`-stripped) names of `pkgName`'s hard `@imajin/*` dependencies. */
function readHardImajinDeps(pkgName) {
  const pkgJsonPath = join(PACKAGES_DIR, pkgName, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
  const deps = pkg.dependencies || {};
  return Object.keys(deps)
    .filter((dep) => dep.startsWith('@imajin/'))
    .map((dep) => dep.replace('@imajin/', ''));
}

describe('SDK_PACKAGES install closure (#2376)', () => {
  const sdkPackages = readSdkPackages();

  it('is non-empty and still includes the four originally-published SDK packages', () => {
    for (const name of ['auth', 'config', 'logger', 'ui']) {
      expect(sdkPackages).toContain(name);
    }
  });

  it('every package.json listed in SDK_PACKAGES actually exists under packages/', () => {
    for (const name of sdkPackages) {
      expect(existsSync(join(PACKAGES_DIR, name, 'package.json')), `packages/${name}/package.json`).toBe(true);
    }
  });

  it.each(sdkPackages)(
    '%s has every hard @imajin/* dependency inside SDK_PACKAGES',
    (pkgName) => {
      const hardDeps = readHardImajinDeps(pkgName);
      const missing = hardDeps.filter((dep) => !sdkPackages.includes(dep));

      expect(
        missing,
        `@imajin/${pkgName} hard-depends on ${missing.map((d) => `@imajin/${d}`).join(', ')}, ` +
          `which ${missing.length === 1 ? 'is' : 'are'} not in SDK_PACKAGES ` +
          `(${WORKFLOW_PATH}). A packages-v* tag would publish @imajin/${pkgName} ` +
          `without ${missing.length === 1 ? 'it' : 'them'}, so a fresh install of the ` +
          `published package fails with ETARGET.`,
      ).toEqual([]);
    },
  );

  it('regression: @imajin/ui\'s hard dependency on @imajin/fair is caught if fair is ever dropped from SDK_PACKAGES', () => {
    // Direct reproduction of the exact gap #2376 found: readHardImajinDeps
    // isn't a no-op, and a package genuinely outside a hypothetical
    // SDK_PACKAGES list is genuinely reported as missing.
    const hardDeps = readHardImajinDeps('ui');
    expect(hardDeps).toContain('fair');

    const hypotheticalSdkPackages = sdkPackages.filter((name) => name !== 'fair');
    const missing = hardDeps.filter((dep) => !hypotheticalSdkPackages.includes(dep));
    expect(missing).toContain('fair');
  });
});
