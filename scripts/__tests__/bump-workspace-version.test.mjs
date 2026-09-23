import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpVersion, setVersionInFile } from '../bump-workspace-version.mjs';

// fileURLToPath, not `.pathname`: on Windows the latter yields "/D:/...", which
// node then resolves against the cwd into "C:\D:\..." and cannot load.
const SCRIPT = fileURLToPath(new URL('../bump-workspace-version.mjs', import.meta.url));

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function writePackageJson(dir, relPath, contents) {
  const fullPath = join(dir, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, `${JSON.stringify(contents, null, 2)}\n`, 'utf8');
}

/** A repo shaped like this one: divergent per-package versions, not already in lockstep. */
function makeDivergentWorkspaceRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-version-bump-'));

  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);

  writePackageJson(dir, 'package.json', { name: 'imajin-ai', version: '0.8.0', private: true });
  writePackageJson(dir, 'packages/ui/package.json', { name: '@imajin/ui', version: '0.8.0' });
  writePackageJson(dir, 'packages/logger/package.json', { name: '@imajin/logger', version: '0.1.0' });
  writePackageJson(dir, 'packages/eslint-config-imajin/package.json', {
    name: 'eslint-config-imajin',
    version: '1.0.0',
  });
  writePackageJson(dir, 'apps/www/package.json', { name: '@imajin/www', version: '0.8.0', private: true });
  writeFileSync(join(dir, 'apps/www/.env.example'), 'FOO=bar\n', 'utf8');

  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);

  return dir;
}

function runScript(dir, bump) {
  return execFileSync(process.execPath, [SCRIPT, bump], {
    encoding: 'utf8',
    cwd: dir,
    env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules'), CI_GUARD_WORKDIR: dir },
  });
}

function readVersion(dir, relPath) {
  return JSON.parse(readFileSync(join(dir, relPath), 'utf8')).version;
}

describe('bumpVersion', () => {
  it('bumps patch, keeping major/minor', () => {
    expect(bumpVersion('0.8.0', 'patch')).toBe('0.8.1');
    expect(bumpVersion('1.2.9', 'patch')).toBe('1.2.10');
  });

  it('bumps minor, resetting patch to 0', () => {
    expect(bumpVersion('0.8.5', 'minor')).toBe('0.9.0');
    expect(bumpVersion('1.2.9', 'minor')).toBe('1.3.0');
  });

  it('rejects a non major.minor.patch version', () => {
    expect(() => bumpVersion('0.8.0-rc.1', 'patch')).toThrow(/unsupported version format/);
  });

  it('rejects an unknown bump type', () => {
    expect(() => bumpVersion('0.8.0', 'major')).toThrow(/unsupported bump type/);
  });
});

describe('setVersionInFile', () => {
  it('rewrites only the version field, preserving the rest of the file byte-for-byte', () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-version-'));
    const filePath = join(dir, 'package.json');
    const original = '{\n  "name": "x",\n  "version": "0.8.0",\n  "private": true\n}\n';
    writeFileSync(filePath, original, 'utf8');

    const changed = setVersionInFile(filePath, '0.8.1');

    expect(changed).toBe(true);
    expect(readFileSync(filePath, 'utf8')).toBe(
      '{\n  "name": "x",\n  "version": "0.8.1",\n  "private": true\n}\n',
    );
  });

  it('returns false and leaves the file untouched when there is no version field', () => {
    const dir = mkdtempSync(join(tmpdir(), 'set-version-'));
    const filePath = join(dir, 'package.json');
    const original = '{\n  "name": "x"\n}\n';
    writeFileSync(filePath, original, 'utf8');

    const changed = setVersionInFile(filePath, '0.8.1');

    expect(changed).toBe(false);
    expect(readFileSync(filePath, 'utf8')).toBe(original);
  });
});

describe('bump-workspace-version script (end-to-end)', () => {
  it('sets every tracked package.json to the same lockstep version, derived from root', () => {
    const dir = makeDivergentWorkspaceRepo();

    const stdout = runScript(dir, 'patch');

    expect(stdout.trim()).toBe('0.8.1');
    expect(readVersion(dir, 'package.json')).toBe('0.8.1');
    expect(readVersion(dir, 'packages/ui/package.json')).toBe('0.8.1');
    // Started at 0.1.0 and 1.0.0 respectively — lockstep means these land on
    // root's new version too, not their own independent +patch.
    expect(readVersion(dir, 'packages/logger/package.json')).toBe('0.8.1');
    expect(readVersion(dir, 'packages/eslint-config-imajin/package.json')).toBe('0.8.1');
    expect(readVersion(dir, 'apps/www/package.json')).toBe('0.8.1');
  });

  it('does not touch unrelated files', () => {
    const dir = makeDivergentWorkspaceRepo();
    runScript(dir, 'minor');
    expect(readFileSync(join(dir, 'apps/www/.env.example'), 'utf8')).toBe('FOO=bar\n');
  });

  it('bumps minor from root, resetting patch to 0', () => {
    const dir = makeDivergentWorkspaceRepo();
    const stdout = runScript(dir, 'minor');
    expect(stdout.trim()).toBe('0.9.0');
    expect(readVersion(dir, 'package.json')).toBe('0.9.0');
  });

  it('rejects an invalid bump argument', () => {
    const dir = makeDivergentWorkspaceRepo();
    expect(() => runScript(dir, 'major')).toThrow();
  });
});
