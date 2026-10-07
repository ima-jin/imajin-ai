#!/usr/bin/env node
/**
 * scripts/provision-service-bootstrap.mjs (#2442, ESM since #2483)
 *
 * Provisions the vault bootstrap identity of every userspace service that
 * declares `<SVC>_VAULT_BOOTSTRAP_DID` in its `apps/<svc>/.env.example`, and
 * ensures each one holds the `ATTESTATION_INTERNAL_API_KEY` grant (#2353) —
 * so a release that needs a new service identity ships through the existing
 * `production` gate tap (the human countersign from #2245) with no keypair
 * minting, no hand-edited `.env.local`, and no hand-run grant script.
 *
 * Per service, reading `apps/<svc>/.env.local`:
 *   - no .env.local at all → skipped (service not configured on this host);
 *   - both keys present and non-empty → left untouched (never rotated);
 *   - exactly one present, or either empty → exit non-zero, nothing changed;
 *   - both absent → mint an Ed25519 keypair + did:imajin DID, register it as
 *     a kernel identity, append the pair (atomically, mode 0600).
 * The grant is then ensured for EVERY service whose pair exists, minted now or
 * not, so a crash between the write and the grant self-heals on the next run.
 * Idempotent: a re-run with everything provisioned changes nothing.
 *
 * Which grant a service gets: the attestation key for every userspace service;
 * for the kernel's own `KERNEL_CRON_VAULT_BOOTSTRAP_*` pair (the `*-kernel-cron`
 * scheduler's identity, #2550) the kernel cron secret instead. Both are
 * vault-generated internal secrets (#2245 pattern) — nobody pastes either.
 *
 * Runs as ESM under plain `node` (#2483), like scripts/migrate.mjs and the
 * other ops scripts that need ESM-only dependencies. The core logic stays
 * TypeScript (scripts/lib/provision-service-bootstrap.ts, which imports the
 * kernel's TypeScript sources) and is compiled to a native ES module at package
 * build time by `@imajin/provision-bootstrap` (packages/provision-bootstrap,
 * built by the same `pnpm -r --filter './packages/**' build` the deploy already
 * runs, #2485); this script only `import()`s the result — nothing is bundled at
 * run time. Every dependency is loaded by Node's native ESM resolver, so every
 * transitive ESM-only package (e.g. `@ipld/dag-cbor`) loads. Run via `tsx`
 * instead and the same sources compile to CommonJS, where those packages fail
 * with `No "exports" main defined`.
 *
 * Usage (from repo root, after `pnpm -r --filter './packages/**' build`):
 *   node scripts/provision-service-bootstrap.mjs --all
 *   node scripts/provision-service-bootstrap.mjs market
 *   node scripts/provision-service-bootstrap.mjs --all --env prod
 *   node scripts/provision-service-bootstrap.mjs --all --dry-run
 *   node scripts/provision-service-bootstrap.mjs --app links --env dev
 *   node scripts/provision-service-bootstrap.mjs --service-dir ~/dev/links --env dev
 *
 * A standalone app that lives in its own repo (links, #1986) is provisioned by
 * pointing at its checkout (#2712) — no symlink into apps/, no hand-made keys:
 *   --service-dir <path>  The app's checkout. Its `.env.example` must declare a
 *                    required `<SVC>_VAULT_BOOTSTRAP_DID` (links:
 *                    `LINKS_VAULT_BOOTSTRAP_DID`); the pair is written to
 *                    `<path>/.env.local`, which must already exist, and the
 *                    attestation-key grant is ensured in the same run.
 *   --app <slug>     Shorthand for --service-dir <kernel checkout>/../<slug> —
 *                    the layout the servers use (~/dev/imajin-ai + ~/dev/links).
 *
 * Options:
 *   --env dev|prod   Take VAULT_PATH from deploy/ecosystem.<env>.config.js
 *                    (where pm2 sets it for the kernel) unless already set in
 *                    the process env — the grant must land in the SAME vault
 *                    file the target kernel reads.
 *   --dry-run        Validate every .env.local pair and load every module a
 *                    real run imports, then stop: nothing is minted, written,
 *                    registered or granted, and the database is never
 *                    contacted (DATABASE_URL is replaced by an unroutable
 *                    placeholder). Exits non-zero on any module-resolution
 *                    error — the CI check that the entrypoint can load.
 *
 * Env (the kernel's own, for the target deployment — same as
 * scripts/grant-attestation-internal-api-key.ts):
 *   DATABASE_URL      — postgres connection string
 *   AUTH_PRIVATE_KEY  — node signing + seal key
 *   VAULT_PATH        — optional; defaults to ~/.imajin/vault.json
 * deploy-*.yml loads them exactly like pm2 starts prod-jin:
 *   node --env-file=apps/kernel/.env.local scripts/provision-service-bootstrap.mjs --all --env prod
 *
 * Output: one line per service — `service · did · minted|existing · grantId` —
 * also appended to $GITHUB_STEP_SUMMARY under GitHub Actions. A private key is
 * never printed, logged or echoed; the grantId is a pointer, not a secret.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ecosystemConfigPath, readEcosystemVaultPath } from './lib/vault-path-sources.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// The pre-built provisioning library (`pnpm -r --filter './packages/**' build`).
const LIB_BUILD = path.join(REPO_ROOT, 'packages', 'provision-bootstrap', 'dist', 'index.mjs');

// The acting principal recorded on the grant's audit log line.
const GRANTED_BY = 'operator:provision-service-bootstrap-script';

// Unroutable and credential-free: --dry-run must never reach a real database.
const DRY_RUN_DATABASE_URL = 'postgres://127.0.0.1:1/provision_dry_run';

const USAGE = [
  'Usage: node scripts/provision-service-bootstrap.mjs (--all | <service> | --service-dir <path> | --app <slug>) [--env dev|prod] [--dry-run]',
].join('\n');

// Flags that take a value, and the `args` field each fills.
const VALUE_FLAGS = new Map([
  ['--env', 'env'],
  ['--service-dir', 'serviceDir'],
  ['--app', 'app'],
]);

// An app slug is one path segment: it is joined onto the kernel checkout's parent directory.
const APP_SLUG = /^[a-z][a-z0-9-]*$/;

/**
 * @param {readonly string[]} argv
 * @returns {{ all: boolean, service: string | null, serviceDir: string | null, app: string | null, env: 'dev' | 'prod' | null, dryRun: boolean }}
 */
function parseArgs(argv) {
  const args = { all: false, service: null, serviceDir: null, app: null, env: null, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--all') {
      args.all = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (VALUE_FLAGS.has(arg)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('-')) throw new Error(`${arg} needs a value\n${USAGE}`);
      args[VALUE_FLAGS.get(arg)] = value;
    } else if (arg.startsWith('-') || args.service !== null) {
      throw new Error(`Unexpected argument '${arg}'\n${USAGE}`);
    } else {
      args.service = arg;
    }
  }
  if (args.env !== null && args.env !== 'dev' && args.env !== 'prod') throw new Error(`--env must be 'dev' or 'prod'\n${USAGE}`);
  const targetCount = [args.all, args.service !== null, args.serviceDir !== null, args.app !== null].filter(Boolean).length;
  if (targetCount !== 1) {
    throw new Error(`Pass exactly one of --all, <service>, --service-dir <path> or --app <slug>\n${USAGE}`);
  }
  if (args.app !== null && !APP_SLUG.test(args.app)) {
    throw new Error(`--app takes a slug like 'links', not '${args.app}' — use --service-dir <path> for a path\n${USAGE}`);
  }
  return args;
}

/** The external checkout the args point at (#2712), or null when they target the kernel's own apps. */
function externalCheckout(args) {
  if (args.serviceDir !== null) {
    const dir = path.resolve(args.serviceDir);
    return { dir, name: path.basename(dir) };
  }
  if (args.app !== null) return { dir: path.resolve(REPO_ROOT, '..', args.app), name: args.app };
  return null;
}

async function loadLib() {
  if (!fs.existsSync(LIB_BUILD)) {
    throw new Error(
      `${path.relative(REPO_ROOT, LIB_BUILD)} is missing — run \`pnpm -r --filter './packages/**' build\` first`,
    );
  }
  return import(pathToFileURL(LIB_BUILD).href);
}

function selectServices(args, lib) {
  const external = externalCheckout(args);
  if (external) return [lib.discoverExternalService(external.dir, external.name)];
  const discovered = lib.discoverServices(REPO_ROOT);
  if (args.all) return discovered;
  const match = discovered.find((service) => service.name === args.service);
  if (!match) {
    const known = discovered.map((service) => service.name).join(', ');
    throw new Error(`Unknown service '${args.service}' — no apps/${args.service}/.env.example declares a *_VAULT_BOOTSTRAP_DID (known: ${known})`);
  }
  return [match];
}

/**
 * pm2 sets the kernel's VAULT_PATH in deploy/ecosystem.<env>.config.js, not in
 * .env.local. A value already in the process env wins, exactly as it does for
 * the kernel itself — which is why .env.local must not set it (#2487):
 * scripts/check-vault-path-consistency.mjs fails the deploy before this runs
 * if it does and the paths differ.
 */
function applyEcosystemVaultPath(env) {
  if (process.env.VAULT_PATH?.trim()) return;
  const vaultPath = readEcosystemVaultPath(ecosystemConfigPath(REPO_ROOT, env), env);
  if (vaultPath) process.env.VAULT_PATH = vaultPath;
}

function writeStepSummary(lines) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile || lines.length === 0) return;
  fs.appendFileSync(summaryFile, `### Service bootstrap identities\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Must be set before the kernel modules load: the kernel's db module reads it at import.
  if (args.dryRun) process.env.DATABASE_URL = DRY_RUN_DATABASE_URL;

  const lib = await loadLib();
  const services = selectServices(args, lib);
  if (services.length === 0) throw new Error('No service declares a *_VAULT_BOOTSTRAP_DID in apps/*/.env.example');

  if (args.dryRun) {
    const lines = await lib.dryRunServices(REPO_ROOT, services);
    for (const line of lines) console.log(line);
    console.log(`dry-run · ${services.length} service(s) validated, kernel modules load as ESM — nothing changed`);
    return;
  }

  if (args.env) applyEcosystemVaultPath(args.env);

  const lines = [];
  try {
    await lib.provisionServices(
      REPO_ROOT,
      services,
      lib.createKernelDeps(GRANTED_BY),
      (result) => {
        const line = lib.formatResult(result);
        lines.push(line);
        console.log(line);
      },
      (service) => console.error(`${service.name} · skipped · no ${lib.envLocalLabel(service)} (not configured on this host)`),
    );
  } finally {
    writeStepSummary(lines);
  }
}

try {
  await main();
  // The kernel's DB pool keeps the event loop alive; this is a one-shot script.
  process.exit(0);
} catch (err) {
  console.error(`provision-service-bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
