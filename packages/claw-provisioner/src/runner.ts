/**
 * Operator-executed provisioner runner (imajin-ai#1933, deliverable 2).
 *
 * Consumes a kernel provision record (`GET /auth/api/agents/provision/:id`),
 * re-renders its envelope locally via `@imajin/claw-envelope` (the same pure
 * generator/renderer the kernel used — deterministic from the provision's
 * own non-secret fields, so no secret ever needs to cross this boundary),
 * materializes the files under `deploy/nanoclaw/rendered/<handle>/`, and for
 * `placement: 'hosted'` (non-dry-run only) runs the `deploy/nanoclaw`
 * compose stack, then reports boot status back via the kernel's shared-
 * secret callback route.
 *
 * v0 scope (imajin-ai#1933): this is an OPERATOR-executed script. Nothing in
 * this package's tests or CI ever shells out to `docker` or writes real
 * files — `dryRun: true` (the default for `--dry-run`) short-circuits every
 * side effect and only reports the plan.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateEnvelope, renderNanoClaw, type ContextEnvelopeInput, type BrainVia } from '@imajin/claw-envelope';

export interface ProvisionRecord {
  id: string;
  servingDid: string;
  agentDid: string | null;
  handle: string;
  harness: string;
  placement: 'hosted' | 'local';
  model: { provider: string; via: BrainVia };
  scopes: string[];
  status: string;
}

export type ExecCompose = (args: readonly string[], cwd: string) => Promise<void>;

export interface RunProvisionOptions {
  kernelBaseUrl: string;
  provisionId: string;
  /** Bearer token for the owning DID's own session/app token - same auth GET /auth/api/agents/provision/:id already requires. */
  operatorToken: string;
  /** Shared secret for the boot-status callback. Required for a non-dry-run hosted run; omit to skip the callback entirely (e.g. local placements). */
  runnerToken?: string;
  /** Defaults to `deploy/nanoclaw/rendered/<handle>` relative to the current working directory. */
  outDir?: string;
  /** Defaults to `deploy/nanoclaw` relative to the current working directory. */
  composeDir?: string;
  /** When true (the CLI's `--dry-run` default), no files are written, no compose command runs, and no callback is sent - only the plan is reported. */
  dryRun?: boolean;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to shelling out to `docker compose`. */
  execCompose?: ExecCompose;
}

export interface RunProvisionResult {
  provision: ProvisionRecord;
  outDir: string;
  /** Absolute paths this run wrote (or, under `dryRun`, would have written). */
  filesWritten: string[];
  composeRan: boolean;
  callbackSent: boolean;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

async function fetchProvision(kernelBaseUrl: string, provisionId: string, operatorToken: string, fetchImpl: typeof fetch): Promise<ProvisionRecord> {
  const res = await fetchImpl(`${stripTrailingSlash(kernelBaseUrl)}/auth/api/agents/provision/${provisionId}`, {
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch provision ${provisionId}: ${res.status}`);
  }
  const body = (await res.json()) as { provision: ProvisionRecord };
  return body.provision;
}

/** Mirrors the kernel's own `envelopeInputFromRow` (apps/kernel/src/lib/auth/agent-provisioner.ts) - deterministic from the provision's stored, non-secret fields. */
function envelopeInputFor(provision: ProvisionRecord): ContextEnvelopeInput {
  if (!provision.agentDid) {
    throw new Error(`Provision ${provision.id} has no agent identity yet (status=${provision.status})`);
  }
  return {
    agentDid: provision.agentDid,
    ownerDid: provision.servingDid,
    handle: provision.handle,
    intent: {
      scopes: provision.scopes,
      busRoutes: [{ eventType: 'chat.message.received', description: 'Inbound DM dispatch to the runtime.' }],
      brain: { placement: 'hosted', provider: provision.model.provider, via: provision.model.via },
      purpose: `Provisioned via the envelope provisioner (#1933) for ${provision.servingDid}.`,
    },
  };
}

async function defaultExecCompose(args: readonly string[], cwd: string): Promise<void> {
  const { execFile } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    execFile('docker', ['compose', ...args], { cwd }, (err) => (err ? reject(err) : resolve()));
  });
}

export async function runProvision(opts: RunProvisionOptions): Promise<RunProvisionResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const dryRun = opts.dryRun ?? false;

  const provision = await fetchProvision(opts.kernelBaseUrl, opts.provisionId, opts.operatorToken, fetchImpl);

  if (provision.harness !== 'nanoclaw') {
    throw new Error(`harness '${provision.harness}' is not yet implemented by the runner - stub only (#1933 deliverable 4)`);
  }

  const envelope = generateEnvelope(envelopeInputFor(provision));
  const rendered = renderNanoClaw(envelope);
  const outDir = opts.outDir ?? join('deploy', 'nanoclaw', 'rendered', provision.handle);

  const filesWritten: string[] = [];
  for (const file of rendered.files) {
    const fullPath = join(outDir, file.relativePath);
    if (!dryRun) {
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, file.content, 'utf-8');
    }
    filesWritten.push(fullPath);
  }

  let composeRan = false;
  if (provision.placement === 'hosted' && !dryRun) {
    const composeDir = opts.composeDir ?? join('deploy', 'nanoclaw');
    const exec = opts.execCompose ?? defaultExecCompose;
    await exec(['build'], composeDir);
    await exec(['up', '-d'], composeDir);
    composeRan = true;
  }

  let callbackSent = false;
  if (provision.placement === 'hosted' && !dryRun && opts.runnerToken) {
    await fetchImpl(`${stripTrailingSlash(opts.kernelBaseUrl)}/auth/api/agents/provision/${provision.id}/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-provisioner-runner-token': opts.runnerToken },
      body: JSON.stringify({ status: 'booted' }),
    });
    callbackSent = true;
  }

  return { provision, outDir, filesWritten, composeRan, callbackSent };
}
