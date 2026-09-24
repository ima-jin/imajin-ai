import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePublishParams, formatAsGithubOutput } from '../resolve-publish-params.mjs';

const SCRIPT = fileURLToPath(new URL('../resolve-publish-params.mjs', import.meta.url));

const ALL_PACKAGES = 'cid tokens config ui vault-core db fair pay auth-client auth logger';
const SDK_PACKAGES = 'auth config logger ui';

describe('resolvePublishParams', () => {
  it('a packages-v* tag push always publishes exactly the SDK packages, GitHub Packages only, never a dry run', () => {
    const result = resolvePublishParams({
      eventName: 'push',
      inputPackage: undefined,
      inputRegistries: undefined,
      inputDryRun: undefined,
      allPackages: ALL_PACKAGES,
      sdkPackages: SDK_PACKAGES,
    });

    expect(result).toEqual({ list: SDK_PACKAGES, doNpmjs: false, doGhp: true, dryRun: false });
  });

  it('workflow_dispatch with package=all expands to the full package list', () => {
    const result = resolvePublishParams({
      eventName: 'workflow_dispatch',
      inputPackage: 'all',
      inputRegistries: 'both',
      inputDryRun: 'false',
      allPackages: ALL_PACKAGES,
      sdkPackages: SDK_PACKAGES,
    });

    expect(result.list).toBe(ALL_PACKAGES);
  });

  it('workflow_dispatch with a single package publishes only that package', () => {
    const result = resolvePublishParams({
      eventName: 'workflow_dispatch',
      inputPackage: 'fair',
      inputRegistries: 'both',
      inputDryRun: 'false',
      allPackages: ALL_PACKAGES,
      sdkPackages: SDK_PACKAGES,
    });

    expect(result.list).toBe('fair');
  });

  it.each([
    ['both', true, true],
    ['npmjs', true, false],
    ['github-packages', false, true],
  ])('registries=%s -> doNpmjs=%s, doGhp=%s', (registries, doNpmjs, doGhp) => {
    const result = resolvePublishParams({
      eventName: 'workflow_dispatch',
      inputPackage: 'ui',
      inputRegistries: registries,
      inputDryRun: 'false',
      allPackages: ALL_PACKAGES,
      sdkPackages: SDK_PACKAGES,
    });

    expect(result.doNpmjs).toBe(doNpmjs);
    expect(result.doGhp).toBe(doGhp);
  });

  it('passes dry_run through for workflow_dispatch', () => {
    const dryRunTrue = resolvePublishParams({
      eventName: 'workflow_dispatch',
      inputPackage: 'ui',
      inputRegistries: 'both',
      inputDryRun: 'true',
      allPackages: ALL_PACKAGES,
      sdkPackages: SDK_PACKAGES,
    });
    const dryRunFalse = resolvePublishParams({
      eventName: 'workflow_dispatch',
      inputPackage: 'ui',
      inputRegistries: 'both',
      inputDryRun: 'false',
      allPackages: ALL_PACKAGES,
      sdkPackages: SDK_PACKAGES,
    });

    expect(dryRunTrue.dryRun).toBe(true);
    expect(dryRunFalse.dryRun).toBe(false);
  });

  it('a packages-v* tag push never reads NPM_TOKEN (do_npmjs is always false)', () => {
    // Regression guard for #1982: the tag path must stay GitHub-Packages-only
    // no matter what the (irrelevant, workflow_dispatch-only) inputs carry
    // over from a prior run's env.
    const result = resolvePublishParams({
      eventName: 'push',
      inputPackage: 'all',
      inputRegistries: 'npmjs',
      inputDryRun: 'true',
      allPackages: ALL_PACKAGES,
      sdkPackages: SDK_PACKAGES,
    });

    expect(result.doNpmjs).toBe(false);
    expect(result.doGhp).toBe(true);
    expect(result.dryRun).toBe(false);
  });
});

describe('formatAsGithubOutput', () => {
  it('formats resolved params as key=value lines', () => {
    const lines = formatAsGithubOutput({ list: 'auth config', doNpmjs: false, doGhp: true, dryRun: false });
    expect(lines).toEqual(['list=auth config', 'do_npmjs=false', 'do_ghp=true', 'dry_run=false']);
  });
});

describe('resolve-publish-params script (end-to-end)', () => {
  function runScript(env) {
    return execFileSync(process.execPath, [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH: join(process.cwd(), 'node_modules'), ...env },
    });
  }

  it('appends GITHUB_OUTPUT-style lines to $GITHUB_OUTPUT when set, for a tag push', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-publish-params-'));
    const outputFile = join(dir, 'github_output');

    runScript({
      GITHUB_EVENT_NAME: 'push',
      ALL_PACKAGES,
      SDK_PACKAGES,
      GITHUB_OUTPUT: outputFile,
    });

    const written = readFileSync(outputFile, 'utf8');
    expect(written).toBe(`list=${SDK_PACKAGES}\ndo_npmjs=false\ndo_ghp=true\ndry_run=false\n`);
  });

  it('resolves a single-package workflow_dispatch end-to-end', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-publish-params-'));
    const outputFile = join(dir, 'github_output');

    runScript({
      GITHUB_EVENT_NAME: 'workflow_dispatch',
      INPUT_PACKAGE: 'cid',
      INPUT_REGISTRIES: 'github-packages',
      INPUT_DRY_RUN: 'true',
      ALL_PACKAGES,
      SDK_PACKAGES,
      GITHUB_OUTPUT: outputFile,
    });

    expect(readFileSync(outputFile, 'utf8')).toBe('list=cid\ndo_npmjs=false\ndo_ghp=true\ndry_run=true\n');
  });
});
