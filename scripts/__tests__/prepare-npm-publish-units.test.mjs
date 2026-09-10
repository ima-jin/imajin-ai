/**
 * Direct (in-process) unit tests for the pure helper functions in
 * scripts/prepare-npm-publish.mjs.
 *
 * scripts/__tests__/prepare-npm-publish.test.mjs already covers the CLI
 * end-to-end behaviour (exit codes, stdout messages, secret isolation) by
 * spawning the script as a subprocess — necessary because it runs its
 * top-level logic (including `process.exit()`) as an import side effect.
 * That subprocess execution can't be instrumented for coverage, so this file
 * imports the module directly (safe now that the CLI entrypoint is guarded
 * by `isMainModule`) and exercises each extracted function on its own.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPathWithin,
  fail,
  ExpectedCliFailure,
  packageLabel,
  rewriteScopeInTree,
  resolveValidatedDirs,
  copyPackageFiles,
  rewriteEntryPoints,
  resolveWorkspaceDependency,
  rewriteWorkspaceDependencies,
  rewritePeerDependenciesMeta,
  rewriteManifestForPublish,
} from '../prepare-npm-publish.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PACKAGES_ROOT = join(REPO_ROOT, 'packages');

describe('isPathWithin', () => {
  it('accepts the root itself and descendants', () => {
    expect(isPathWithin('/a/b', '/a/b')).toBe(true);
    expect(isPathWithin('/a/b', '/a/b/c')).toBe(true);
  });

  it('rejects a sibling whose name merely starts with the root name', () => {
    expect(isPathWithin('/a/b', '/a/b-evil')).toBe(false);
  });

  it('rejects a parent or unrelated path', () => {
    expect(isPathWithin('/a/b', '/a')).toBe(false);
    expect(isPathWithin('/a/b', '/x/y')).toBe(false);
  });
});

describe('fail', () => {
  it('logs the message and throws ExpectedCliFailure', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => fail('boom')).toThrow(ExpectedCliFailure);
      expect(spy).toHaveBeenCalledWith('boom');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('packageLabel', () => {
  it('formats a valid name/version pair', () => {
    expect(packageLabel({ name: '@ima-jin/fixture', version: '1.2.3' })).toBe('@ima-jin/fixture@1.2.3');
  });

  it('fails on a non-string name', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => packageLabel({ name: 123, version: '1.0.0' })).toThrow(ExpectedCliFailure);
    } finally {
      spy.mockRestore();
    }
  });

  it('fails on a non-semver version', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => packageLabel({ name: '@ima-jin/fixture', version: 'latest' })).toThrow(ExpectedCliFailure);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('resolveValidatedDirs', () => {
  it('resolves srcDir/destDir/packagesDir for a package under packages/', () => {
    const srcDir = mkdtempSync(join(PACKAGES_ROOT, '.tmp-units-src-'));
    const outDir = mkdtempSync(join(tmpdir(), 'prepare-npm-publish-units-out-'));
    try {
      const result = resolveValidatedDirs(srcDir, outDir);
      expect(result.srcDir).toBe(srcDir);
      expect(result.destDir).toBe(outDir);
      expect(result.packagesDir).toBe(PACKAGES_ROOT);
    } finally {
      rmSync(srcDir, { recursive: true, force: true });
      rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('fails for a source dir outside packages/', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => resolveValidatedDirs(REPO_ROOT, tmpdir())).toThrow(ExpectedCliFailure);
    } finally {
      spy.mockRestore();
    }
  });

  it('fails for an output dir outside the repo root and OS temp dir', () => {
    const srcDir = mkdtempSync(join(PACKAGES_ROOT, '.tmp-units-src-'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => resolveValidatedDirs(srcDir, '/this-path-should-not-exist-units')).toThrow(ExpectedCliFailure);
    } finally {
      spy.mockRestore();
      rmSync(srcDir, { recursive: true, force: true });
    }
  });
});

describe('copyPackageFiles', () => {
  let srcDir;
  let destDir;
  let logSpy;
  let warnSpy;

  beforeEach(() => {
    srcDir = mkdtempSync(join(tmpdir(), 'prepare-npm-publish-units-src-'));
    destDir = mkdtempSync(join(tmpdir(), 'prepare-npm-publish-units-dest-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(destDir, { recursive: true, force: true });
  });

  it('copies listed files and common extras that exist, warning about the ones that do not', () => {
    mkdirSync(join(srcDir, 'dist'));
    writeFileSync(join(srcDir, 'dist', 'index.js'), 'module.exports = {};');
    writeFileSync(join(srcDir, 'README.md'), '# fixture');

    copyPackageFiles({ files: ['dist', 'missing-dir'] }, srcDir, destDir);

    expect(logSpy).toHaveBeenCalledWith('  Copied dist');
    expect(warnSpy).toHaveBeenCalledWith('  Warning: missing-dir not found, skipping');
    expect(logSpy).toHaveBeenCalledWith('  Copied README.md');
  });

  it('falls back to the dist/src default when pkg.files is absent', () => {
    mkdirSync(join(srcDir, 'src'));
    writeFileSync(join(srcDir, 'src', 'index.ts'), 'export {};');

    copyPackageFiles({}, srcDir, destDir);

    expect(logSpy).toHaveBeenCalledWith('  Copied src');
  });
});

describe('rewriteEntryPoints', () => {
  it('rewrites main/types from src/ to dist/', () => {
    const pkg = { main: './src/index.ts', types: './src/index.ts' };
    rewriteEntryPoints(pkg);
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
  });

  it('rewrites string exports into ESM/CJS/types condition objects and scopes external refs', () => {
    const pkg = {
      exports: {
        '.': './src/index.ts',
        '@imajin/fixture/react': './src/react.tsx',
      },
    };
    rewriteEntryPoints(pkg);
    expect(pkg.exports['@ima-jin/fixture/react']).toEqual({
      types: './dist/react.d.ts',
      import: './dist/react.mjs',
      require: './dist/react.js',
    });
    expect(pkg.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.mjs',
      require: './dist/index.js',
    });
  });

  it('does nothing when there is no main/types/exports', () => {
    const pkg = { name: '@ima-jin/fixture' };
    expect(() => rewriteEntryPoints(pkg)).not.toThrow();
    expect(pkg).toEqual({ name: '@ima-jin/fixture' });
  });
});

describe('resolveWorkspaceDependency / rewriteWorkspaceDependencies', () => {
  it('leaves a non-workspace dependency untouched', () => {
    expect(resolveWorkspaceDependency('lodash', '^4.0.0', PACKAGES_ROOT)).toEqual(['lodash', '^4.0.0']);
  });

  it('resolves a workspace:* dependency to its published @ima-jin scope + version', () => {
    const [name, version] = resolveWorkspaceDependency('@imajin/cid', 'workspace:*', PACKAGES_ROOT);
    expect(name).toBe('@ima-jin/cid');
    expect(version).toMatch(/^\^\d+\.\d+\.\d+/);
  });

  it('keeps a workspace:* dependency as-is when the local package cannot be resolved', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const [name, version] = resolveWorkspaceDependency('@imajin/does-not-exist', 'workspace:*', PACKAGES_ROOT);
      expect(name).toBe('@imajin/does-not-exist');
      expect(version).toBe('workspace:*');
      expect(warnSpy).toHaveBeenCalledWith('  Warning: could not resolve @imajin/does-not-exist, keeping as-is');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('rewrites dependencies and peerDependencies, and no-ops when neither is present', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const pkg = {
        dependencies: { '@imajin/cid': 'workspace:*', lodash: '^4.0.0' },
        peerDependencies: { '@imajin/cid': 'workspace:*' },
      };
      rewriteWorkspaceDependencies(pkg, PACKAGES_ROOT);
      expect(pkg.dependencies.lodash).toBe('^4.0.0');
      expect(pkg.dependencies['@ima-jin/cid']).toMatch(/^\^\d+\.\d+\.\d+/);
      expect(pkg.peerDependencies['@ima-jin/cid']).toMatch(/^\^\d+\.\d+\.\d+/);

      expect(() => rewriteWorkspaceDependencies({}, PACKAGES_ROOT)).not.toThrow();
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('rewritePeerDependenciesMeta', () => {
  it('rewrites @imajin/* keys to @ima-jin/*', () => {
    const pkg = { peerDependenciesMeta: { '@imajin/auth': { optional: true } } };
    rewritePeerDependenciesMeta(pkg);
    expect(pkg.peerDependenciesMeta).toEqual({ '@ima-jin/auth': { optional: true } });
  });

  it('no-ops when absent', () => {
    expect(() => rewritePeerDependenciesMeta({})).not.toThrow();
  });
});

describe('rewriteManifestForPublish', () => {
  it('applies every rewrite needed to make a workspace manifest publishable', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const pkg = {
        name: '@imajin/fixture',
        version: '1.0.0',
        private: true,
        scripts: { build: 'tsup' },
        devDependencies: { typescript: '^5.0.0' },
        main: './src/index.ts',
        dependencies: { '@imajin/cid': 'workspace:*' },
        peerDependenciesMeta: { '@imajin/auth': { optional: true } },
      };
      rewriteManifestForPublish(pkg, PACKAGES_ROOT);

      expect(pkg.name).toBe('@ima-jin/fixture');
      expect(pkg.private).toBeUndefined();
      expect(pkg.publishConfig).toEqual({ access: 'public' });
      expect(pkg.scripts).toBeUndefined();
      expect(pkg.devDependencies).toBeUndefined();
      expect(pkg.main).toBe('./dist/index.js');
      expect(pkg.dependencies['@ima-jin/cid']).toMatch(/^\^\d+\.\d+\.\d+/);
      expect(pkg.peerDependenciesMeta).toEqual({ '@ima-jin/auth': { optional: true } });
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe('rewriteScopeInTree', () => {
  it('rewrites @imajin/ to @ima-jin/ in rewritable files, recursing into subdirectories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prepare-npm-publish-units-tree-'));
    try {
      mkdirSync(join(dir, 'nested'));
      writeFileSync(join(dir, 'index.js'), "import x from '@imajin/cid';");
      writeFileSync(join(dir, 'nested', 'inner.mjs'), "import y from '@imajin/db';");
      writeFileSync(join(dir, 'README.md'), 'no scope references here');

      const count = rewriteScopeInTree(dir);

      expect(count).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
