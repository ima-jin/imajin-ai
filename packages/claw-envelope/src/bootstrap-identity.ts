#!/usr/bin/env node
/**
 * Agent identity bootstrap (imajin-ai#1932 scope item 1).
 *
 * Registers the NanoClaw instance as its OWN principal using the kernel's
 * EXISTING agent-registration flow — `POST /auth/api/agents`
 * (`apps/kernel/app/auth/api/agents/route.ts`) — which already mints an
 * Ed25519 keypair server-side and wires both `identity_members` rows (owner
 * + reverse `role: 'agent'`) atomically. This script does not reinvent any
 * of that; it only calls it, then issues a minimal delegation grant on top
 * via `POST /auth/api/grants` (#1882) from the closed capability registry
 * (`@imajin/auth`'s `GRANT_SCOPE_REGISTRY`).
 *
 * The returned keypair is written to `NANOCLAW_AGENT_KEYPAIR_PATH` with
 * 0600 permissions and is NEVER printed or logged.
 *
 * `usage.emitters` registration (`PUT /usage/api/emitters`) is deliberately
 * NOT done here — like `packages/usage-emitter-claude-code`'s own README,
 * that is a one-time owner action documented in
 * `packages/nanoclaw-imajin-channel/README.md` and the runbook, performed
 * with the OWNER's own session (the emitter registry is owner-only by
 * construction).
 */
import { chmodSync, writeFileSync } from 'node:fs';
import { isKnownGrantScope } from '@imajin/auth';

export interface BootstrapArgs {
  kernelBaseUrl: string;
  handle: string;
  displayName?: string;
  /** Bearer session/app token for the OWNER's own authenticated session — grants must be issued by the delegator directly (#1882). */
  ownerToken: string;
  capabilities: string[];
  audienceDids: string[];
  keypairPath: string;
  dryRun: boolean;
}

export interface CreatedAgent {
  did: string;
  handle: string;
  keypair: { privateKey: string; publicKey: string };
}

export interface IssuedGrant {
  grantId: string;
}

export interface BootstrapResult {
  agent: Pick<CreatedAgent, 'did' | 'handle'>;
  grant: IssuedGrant | null;
  dryRun: boolean;
}

/** Strip a single trailing `/`, if present. */
function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function validateCapabilities(capabilities: readonly string[]): void {
  const invalid = capabilities.filter((c) => !isKnownGrantScope(c));
  if (invalid.length > 0) {
    throw new Error(
      `Unknown grant capabilities (not in @imajin/auth's GRANT_SCOPE_REGISTRY): ${invalid.join(', ')}`,
    );
  }
}

async function createAgent(args: BootstrapArgs): Promise<CreatedAgent> {
  const res = await fetch(`${stripTrailingSlash(args.kernelBaseUrl)}/auth/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.ownerToken}` },
    body: JSON.stringify({ handle: args.handle, displayName: args.displayName }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(`POST /auth/api/agents failed: ${res.status} ${body.error ?? res.statusText}`);
  }
  return (await res.json()) as CreatedAgent;
}

async function issueGrant(args: BootstrapArgs, agentDid: string): Promise<IssuedGrant> {
  const res = await fetch(`${stripTrailingSlash(args.kernelBaseUrl)}/auth/api/grants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${args.ownerToken}` },
    body: JSON.stringify({
      agentDid,
      capabilities: args.capabilities,
      audience: { type: 'dids', values: args.audienceDids },
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
    throw new Error(`POST /auth/api/grants failed: ${res.status} ${body.error ?? res.statusText}`);
  }
  const { grant } = (await res.json()) as { grant: { grantId: string } };
  return { grantId: grant.grantId };
}

/** Write the keypair to disk with 0600 perms. Never logs the private key. */
function persistKeypair(path: string, keypair: CreatedAgent['keypair']): void {
  writeFileSync(path, JSON.stringify(keypair, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on platforms where writeFileSync's mode isn't honored verbatim.
  }
}

export async function bootstrapIdentity(args: BootstrapArgs): Promise<BootstrapResult> {
  validateCapabilities(args.capabilities);

  if (args.dryRun) {
    return {
      agent: { did: '(dry-run, no call made)', handle: args.handle },
      grant: null,
      dryRun: true,
    };
  }

  const agent = await createAgent(args);
  persistKeypair(args.keypairPath, agent.keypair);
  const grant = args.capabilities.length > 0 ? await issueGrant(args, agent.did) : null;

  return { agent: { did: agent.did, handle: agent.handle }, grant, dryRun: false };
}

function parseArgs(argv: readonly string[]): BootstrapArgs {
  const get = (flag: string): string | undefined => {
    const idx = argv.indexOf(flag);
    return idx === -1 ? undefined : argv[idx + 1];
  };
  const kernelBaseUrl = get('--kernel-url') ?? process.env.KERNEL_BASE_URL ?? '';
  const handle = get('--handle') ?? '';
  const displayName = get('--display-name');
  const ownerToken = get('--owner-token') ?? process.env.OWNER_TOKEN ?? '';
  const capabilitiesRaw = get('--capabilities') ?? 'messages:read,messages:write,discovery:read';
  const audienceRaw = get('--audience-dids') ?? '';
  const keypairPath = get('--keypair-path') ?? process.env.NANOCLAW_AGENT_KEYPAIR_PATH ?? '';
  const dryRun = argv.includes('--dry-run');

  if (!dryRun) {
    if (!kernelBaseUrl) throw new Error('--kernel-url (or KERNEL_BASE_URL) is required');
    if (!ownerToken) throw new Error('--owner-token (or OWNER_TOKEN) is required');
    if (!keypairPath) throw new Error('--keypair-path (or NANOCLAW_AGENT_KEYPAIR_PATH) is required');
    if (!audienceRaw) throw new Error('--audience-dids is required (comma-separated DIDs)');
  }
  if (!handle) throw new Error('--handle is required');

  return {
    kernelBaseUrl,
    handle,
    displayName,
    ownerToken,
    capabilities: capabilitiesRaw.split(',').map((c) => c.trim()).filter(Boolean),
    audienceDids: audienceRaw.split(',').map((d) => d.trim()).filter(Boolean),
    keypairPath,
    dryRun,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) {
    console.log('[dry-run] Would call POST /auth/api/agents with:', {
      url: `${args.kernelBaseUrl || '<KERNEL_BASE_URL>'}/auth/api/agents`,
      body: { handle: args.handle, displayName: args.displayName },
    });
    console.log('[dry-run] Would call POST /auth/api/grants with:', {
      url: `${args.kernelBaseUrl || '<KERNEL_BASE_URL>'}/auth/api/grants`,
      body: { agentDid: '<newly-created-agent-did>', capabilities: args.capabilities, audience: { type: 'dids', values: args.audienceDids } },
    });
    console.log(`[dry-run] Would write keypair to ${args.keypairPath || '<NANOCLAW_AGENT_KEYPAIR_PATH>'} (mode 0600, never printed).`);
    return;
  }
  const result = await bootstrapIdentity(args);
  console.log(`Registered agent ${sanitizeForLog(result.agent.did)} (handle: ${sanitizeForLog(result.agent.handle)}).`);
  if (result.grant) {
    console.log(`Issued grant ${sanitizeForLog(result.grant.grantId)} with capabilities: ${args.capabilities.join(', ')}`);
  }
  console.log(`Keypair written to ${args.keypairPath} (0600). Never logged.`);
}

/** Strip CR/LF before interpolating a kernel-returned value into a log line, to prevent log-line forging. */
function sanitizeForLog(value: string): string {
  return value.replace(/[\r\n]/g, ' ');
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    await main();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('bootstrap-identity: fatal error', sanitizeForLog(message));
    process.exitCode = 1;
  }
}
