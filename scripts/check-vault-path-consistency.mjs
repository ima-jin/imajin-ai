#!/usr/bin/env node
/**
 * check-vault-path-consistency.mjs (#2487) — pre-deploy VAULT_PATH check.
 *
 * Fails the deploy, naming both paths, when the vault file the provisioning
 * step (#2442) will write to is not the file the kernel reads. Run it BEFORE
 * `provision-service-bootstrap.mjs` in deploy-prod.yml / deploy-dev.yml.
 *
 * Usage:
 *   node scripts/check-vault-path-consistency.mjs --env prod|dev
 *        [--pm2-jlist-file <file>] [--ecosystem-file <file>] [--root <dir>]
 *
 *   --pm2-jlist-file  `pm2 jlist` output; also compares the RUNNING kernel's
 *                     VAULT_PATH. Omit on a first deploy (nothing running yet).
 *   --ecosystem-file  The live ecosystem file pm2 restarts from (the deploy's
 *                     $ECOSYSTEM_FILE). Defaults to deploy/ecosystem.<env>.config.js
 *                     in the repo — the file the deploy's sync step copies there.
 *   --root            Repo root (tests).
 *
 * The shell's own VAULT_PATH, if any, is treated as an operator override of the
 * provisioner, exactly as `node --env-file` treats it.
 *
 * Output: paths and verdicts only, also appended to $GITHUB_STEP_SUMMARY. It
 * never opens the vault, and never prints any pm2 env value except VAULT_PATH.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KERNEL_PROCESS,
  ecosystemConfigPath,
  evaluateVaultPathSources,
  kernelEnvLocalPath,
  readEcosystemVaultPath,
  readEnvFileValue,
  readPm2VaultPath,
} from './lib/vault-path-sources.mjs';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USAGE =
  'Usage: node scripts/check-vault-path-consistency.mjs --env prod|dev [--pm2-jlist-file <file>] [--ecosystem-file <file>] [--root <dir>]';

function parseArgs(argv) {
  const args = { env: null, pm2JlistFile: null, ecosystemFile: null, root: DEFAULT_ROOT };
  const flags = { '--env': 'env', '--pm2-jlist-file': 'pm2JlistFile', '--ecosystem-file': 'ecosystemFile', '--root': 'root' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = flags[argv[i]];
    const value = argv[i + 1];
    if (!key || value === undefined) throw new Error(`Unrecognised or incomplete argument '${argv[i]}'\n${USAGE}`);
    args[key] = value;
  }
  if (!Object.hasOwn(KERNEL_PROCESS, args.env ?? '')) throw new Error(`--env must be 'dev' or 'prod'\n${USAGE}`);
  return args;
}

function writeStepSummary(lines) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  fs.appendFileSync(summaryFile, `### VAULT_PATH consistency\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const processName = KERNEL_PROCESS[args.env];
  const ecosystemFile = args.ecosystemFile ?? ecosystemConfigPath(args.root, args.env);

  const running = args.pm2JlistFile
    ? readPm2VaultPath(fs.readFileSync(args.pm2JlistFile, 'utf8'), processName)
    : undefined;

  const result = evaluateVaultPathSources({
    envName: args.env,
    processName,
    ecosystem: readEcosystemVaultPath(ecosystemFile, args.env),
    envLocal: readEnvFileValue(kernelEnvLocalPath(args.root), 'VAULT_PATH'),
    shell: process.env.VAULT_PATH,
    running,
  });

  const { paths } = result;
  const lines = [
    `${processName}: ecosystem VAULT_PATH   ${paths.ecosystem ?? '(unset)'}`,
    `${processName}: provisioner will use   ${paths.provisioner ?? '(unset)'}`,
    `${processName}: restart would resolve  ${paths.restart ?? '(unset)'}`,
    `${processName}: running kernel uses    ${running?.running ? (paths.running ?? '(unset)') : '(not running — skipped)'}`,
  ];
  for (const warning of result.warnings) lines.push(`WARNING: ${warning}`);
  for (const error of result.errors) lines.push(`ERROR: ${error}`);
  lines.push(result.errors.length > 0 ? 'FAIL: VAULT_PATH sources disagree' : 'OK: VAULT_PATH has a single resolved vault file');

  console.log(lines.join('\n'));
  writeStepSummary(lines);
  process.exit(result.errors.length > 0 ? 1 : 0);
}

try {
  main();
} catch (error) {
  console.error(`check-vault-path-consistency: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
