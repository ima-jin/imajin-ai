/**
 * scripts/lib/vault-path-sources.mjs (#2487)
 *
 * Every place a kernel's `VAULT_PATH` can come from, and how each one resolves,
 * so the deploy can prove they agree BEFORE anything is provisioned or restarted.
 *
 * The kernel's `VAULT_PATH` has ONE source of truth: the `env` block of the
 * kernel app (`prod-jin` / `dev-jin`) in `deploy/ecosystem.<env>.config.js`.
 * pm2 hands it to the process, and process env beats the kernel's
 * `--env-file=apps/kernel/.env.local`. The other sources exist only to be
 * compared against it:
 *
 *   - ecosystem config   — what a `pm2 startOrRestart <ecosystem>` produces
 *   - `.env.local`       — must NOT set it; if it does, the provisioner (run as
 *                          `node --env-file=.env.local …`) reads THAT, while the
 *                          running kernel ignores it. That split is #2487.
 *   - running pm2 env    — what the live kernel actually resolved (`pm2 jlist`)
 *   - shell env          — an operator override; beats `.env.local` for the
 *                          provisioner (`--env-file` never overwrites it)
 *
 * Only paths ever leave this module — never vault contents, never the rest of a
 * pm2 process's environment (which holds real secrets).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** pm2 process name of the kernel for each deploy environment. */
export const KERNEL_PROCESS = { dev: 'dev-jin', prod: 'prod-jin' };

/** Repo-relative location of an environment's ecosystem config. */
export function ecosystemConfigPath(root, env) {
  return path.join(root, 'deploy', `ecosystem.${env}.config.js`);
}

/** Repo-relative location of the kernel's `.env.local`. */
export function kernelEnvLocalPath(root) {
  return path.join(root, 'apps', 'kernel', '.env.local');
}

function nonBlank(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Mirrors apps/kernel/src/lib/vault/vault-path.ts: trim, then a leading `~` is
 * the home directory. Returns an absolute, normalised path so two spellings of
 * the same file compare equal.
 */
export function normalizeVaultPath(rawPath, homeDir = os.homedir()) {
  const raw = nonBlank(rawPath);
  if (raw === undefined) return undefined;
  let expanded = raw;
  if (raw === '~') expanded = homeDir;
  else if (raw.startsWith('~/') || raw.startsWith('~\\')) expanded = path.join(homeDir, raw.slice(2));
  return path.resolve(expanded);
}

/**
 * `env.VAULT_PATH` of the kernel app in an ecosystem config file (raw, as
 * written). The module is loaded, not regex-scanned, so another app's
 * VAULT_PATH can never be picked up by mistake.
 */
export function readEcosystemVaultPath(ecosystemFile, env) {
  if (!fs.existsSync(ecosystemFile)) return undefined;
  const apps = require(ecosystemFile)?.apps;
  if (!Array.isArray(apps)) return undefined;
  const kernel = apps.find((app) => app?.name === KERNEL_PROCESS[env]);
  return nonBlank(kernel?.env?.VAULT_PATH);
}

/**
 * Value of `key` in a dotenv-style file (raw, as written), or undefined when the
 * file or key is absent or the value is blank. Later assignments win, like
 * `node --env-file`.
 */
export function readEnvFileValue(envFile, key) {
  if (!fs.existsSync(envFile)) return undefined;
  let value;
  for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart();
    const eq = line.indexOf('=');
    if (eq === -1 || line.slice(0, eq).trim() !== key) continue;
    value = parseEnvValue(line.slice(eq + 1));
  }
  return nonBlank(value);
}

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'" || quote === '`') {
    const end = trimmed.indexOf(quote, 1);
    return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
  }
  const comment = trimmed.indexOf(' #');
  return comment === -1 ? trimmed : trimmed.slice(0, comment);
}

/**
 * The `VAULT_PATH` the running pm2 process was started with, out of
 * `pm2 jlist` output. Deliberately extracts nothing else: a pm2 process's env
 * holds secrets.
 *
 * @returns {{ running: boolean, vaultPath: string | undefined }}
 */
export function readPm2VaultPath(jlistText, processName) {
  let list;
  try {
    list = JSON.parse(jlistText);
  } catch {
    // Never echo the text: it is a dump of process environments.
    throw new Error('pm2 jlist output is not valid JSON');
  }
  const proc = Array.isArray(list) ? list.find((p) => p?.name === processName) : undefined;
  if (!proc) return { running: false, vaultPath: undefined };
  return { running: true, vaultPath: nonBlank(proc.pm2_env?.VAULT_PATH) };
}

/**
 * Compares every source and reports what disagrees. Pure: callers pass raw
 * values, this normalises and judges.
 *
 * Resolution it mirrors:
 *   provisioner = shell env || .env.local || ecosystem   (`node --env-file`, then
 *                 provision-service-bootstrap.mjs's ecosystem fallback)
 *   restart     = ecosystem || .env.local                (pm2 env beats --env-file)
 *   running     = pm2's live env, when the kernel is up
 *
 * @param {{ envName: string, processName: string, ecosystem?: string,
 *   envLocal?: string, shell?: string, running?: { running: boolean, vaultPath?: string },
 *   homeDir?: string }} sources raw values as written
 * @returns {{ errors: string[], warnings: string[], paths: Record<string, string | undefined> }}
 */
export function evaluateVaultPathSources(sources) {
  const { envName, processName, running, homeDir } = sources;
  const norm = (value) => normalizeVaultPath(value, homeDir);
  const ecosystem = norm(sources.ecosystem);
  const envLocal = norm(sources.envLocal);
  const shell = norm(sources.shell);
  // The live kernel's pm2 env wins; without one it falls through to .env.local
  // (`--env-file` for prod-jin, Next's own loader for dev-jin).
  const live = running?.running ? (norm(running.vaultPath) ?? envLocal) : undefined;

  const provisioner = shell ?? envLocal ?? ecosystem;
  const restart = ecosystem ?? envLocal;
  const errors = [];
  const warnings = [];

  const ecosystemName = `deploy/ecosystem.${envName}.config.js`;
  if (!ecosystem) {
    errors.push(
      `${ecosystemName} does not set VAULT_PATH in the ${processName} env block — it is the single source of truth for the vault file; add it there.`,
    );
  }

  if (envLocal && ecosystem && envLocal !== ecosystem) {
    errors.push(
      `apps/kernel/.env.local sets VAULT_PATH=${envLocal} but ${ecosystemName} sets ${ecosystem}. ` +
        `The provisioning step would read ${envLocal} while ${processName} reads ${ecosystem}. ` +
        'Remove VAULT_PATH from apps/kernel/.env.local.',
    );
  } else if (envLocal) {
    warnings.push(
      `apps/kernel/.env.local also sets VAULT_PATH (${envLocal}); it matches ${ecosystemName} today but is a second source of truth — remove it from .env.local.`,
    );
  }

  if (shell && ecosystem && shell !== ecosystem) {
    errors.push(
      `The deploy shell env sets VAULT_PATH=${shell} but ${ecosystemName} sets ${ecosystem}: the provisioning step would use ${shell}, ${processName} uses ${ecosystem}.`,
    );
  }

  if (running?.running) {
    if (!live) {
      errors.push(
        `Running ${processName} has no VAULT_PATH in its pm2 env or apps/kernel/.env.local — it would not read the vault ${provisioner ?? 'the provisioner'} provisions into.`,
      );
    } else {
      if (provisioner && live !== provisioner) {
        errors.push(
          `Vault file mismatch: the provisioning step would use ${provisioner} but the running ${processName} uses ${live}.`,
        );
      }
      if (restart && live !== restart) {
        errors.push(
          `Running ${processName} uses ${live} (pm2 env) but a restart from the ecosystem config alone resolves ${restart}. ` +
            'Fix the ecosystem config (or the hand-set pm2 env) so they agree.',
        );
      }
    }
  }

  return { errors, warnings, paths: { ecosystem, envLocal, shell, provisioner, restart, running: live } };
}
