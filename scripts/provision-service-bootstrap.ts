#!/usr/bin/env tsx
/**
 * scripts/provision-service-bootstrap.ts (#2442)
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
 * Usage (from repo root):
 *   pnpm exec tsx scripts/provision-service-bootstrap.ts --all
 *   pnpm exec tsx scripts/provision-service-bootstrap.ts market
 *   pnpm exec tsx scripts/provision-service-bootstrap.ts --all --env prod
 *
 * Options:
 *   --env dev|prod   Take VAULT_PATH from deploy/ecosystem.<env>.config.js
 *                    (where pm2 sets it for the kernel) unless already set in
 *                    the process env — the grant must land in the SAME vault
 *                    file the target kernel reads.
 *
 * Env (the kernel's own, for the target deployment — same as
 * scripts/grant-attestation-internal-api-key.ts):
 *   DATABASE_URL      — postgres connection string
 *   AUTH_PRIVATE_KEY  — node signing + seal key
 *   VAULT_PATH        — optional; defaults to ~/.imajin/vault.json
 * deploy-*.yml loads them exactly like pm2 starts prod-jin:
 *   pnpm exec tsx --env-file=apps/kernel/.env.local scripts/provision-service-bootstrap.ts --all --env prod
 *
 * Output: one line per service — `service · did · minted|existing · grantId` —
 * also appended to $GITHUB_STEP_SUMMARY under GitHub Actions. A private key is
 * never printed, logged or echoed; the grantId is a pointer, not a secret.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createKernelDeps,
  discoverServices,
  formatResult,
  provisionServices,
  type BootstrapService,
} from './lib/provision-service-bootstrap.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// The acting principal recorded on the grant's audit log line.
const GRANTED_BY = 'operator:provision-service-bootstrap-script';

const USAGE = [
  'Usage: pnpm exec tsx scripts/provision-service-bootstrap.ts (--all | <service>) [--env dev|prod]',
].join('\n');

interface CliArgs {
  all: boolean;
  service: string | null;
  env: 'dev' | 'prod' | null;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { all: false, service: null, env: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--all') {
      args.all = true;
    } else if (arg === '--env') {
      const value = argv[++i];
      if (value !== 'dev' && value !== 'prod') throw new Error(`--env must be 'dev' or 'prod'\n${USAGE}`);
      args.env = value;
    } else if (arg.startsWith('-') || args.service !== null) {
      throw new Error(`Unexpected argument '${arg}'\n${USAGE}`);
    } else {
      args.service = arg;
    }
  }
  if (args.all === (args.service !== null)) throw new Error(`Pass exactly one of --all or <service>\n${USAGE}`);
  return args;
}

function selectServices(args: CliArgs): BootstrapService[] {
  const discovered = discoverServices(REPO_ROOT);
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
 * .env.local (same lookup as scripts/check-env.ts). A value already in the
 * process env wins, exactly as it does for the kernel itself.
 */
function applyEcosystemVaultPath(env: 'dev' | 'prod'): void {
  if (process.env.VAULT_PATH?.trim()) return;
  const file = path.join(REPO_ROOT, 'deploy', `ecosystem.${env}.config.js`);
  if (!fs.existsSync(file)) return;
  const vaultPath = /"VAULT_PATH"\s*:\s*"([^"]*)"/.exec(fs.readFileSync(file, 'utf8'))?.[1];
  if (vaultPath) process.env.VAULT_PATH = vaultPath;
}

function writeStepSummary(lines: readonly string[]): void {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile || lines.length === 0) return;
  fs.appendFileSync(summaryFile, `### Service bootstrap identities\n\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const services = selectServices(args);
  if (services.length === 0) throw new Error('No service declares a *_VAULT_BOOTSTRAP_DID in apps/*/.env.example');
  if (args.env) applyEcosystemVaultPath(args.env);

  const lines: string[] = [];
  try {
    await provisionServices(
      REPO_ROOT,
      services,
      createKernelDeps(GRANTED_BY),
      (result) => {
        const line = formatResult(result);
        lines.push(line);
        console.log(line);
      },
      (service) => console.error(`${service.name} · skipped · no apps/${service.name}/.env.local (not configured on this host)`),
    );
  } finally {
    writeStepSummary(lines);
  }
}

main().then(
  () => {
    // The kernel's DB pool keeps the event loop alive; this is a one-shot script.
    process.exit(0);
  },
  (err: unknown) => {
    console.error(`provision-service-bootstrap failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
