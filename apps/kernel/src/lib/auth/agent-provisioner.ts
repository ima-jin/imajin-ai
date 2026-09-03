/**
 * Envelope provisioner (#1933, RFC-31 v2).
 *
 * Turns the hand-built NanoClaw first boot (#1932 -> PR #1960) into a
 * repeatable flow: mint identity + issue minimal grants + assemble the RFC-31
 * envelope via `@imajin/claw-envelope`, recording every step so a
 * half-failed provision is legible, not silent. Reuses existing primitives
 * rather than re-implementing them:
 *   - identity mint: `mintAgentIdentity()` (itself extracted from the
 *     pre-existing `POST /auth/api/agents`, #1933 refactor)
 *   - grants: `issueGrant()` / `revokeGrant()` (#1882, unchanged)
 *   - envelope: `generateEnvelope()` + `renderNanoClaw()` (`@imajin/claw-envelope`)
 *
 * `harness: 'openclaw'` is a documented stub (issue #1933 deliverable 4):
 * identity and grants proceed normally, but the envelope-render step fails
 * with an explicit "not yet implemented" error, visible in `steps` — never
 * a silent no-op.
 */
import { desc, eq, and } from 'drizzle-orm';
import { db, agentProvisions, type AgentProvisionRow, type AgentProvisionStep, type AgentProvisionEnvelopeManifest } from '@/src/db';
import { generateId } from '@/src/lib/kernel/id';
import { mintAgentIdentity, MintAgentIdentityError } from './agent-identity';
import { issueGrant, revokeGrant } from './grants';
import { generateEnvelope, renderNanoClaw, validateIntentScopes, type ContextEnvelopeInput, type BrainVia, type RenderedTree } from '@imajin/claw-envelope';
import { publish } from '@imajin/bus';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

export class ProvisionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ProvisionError';
  }
}

export type ProvisionHarness = 'nanoclaw' | 'openclaw';
export type ProvisionPlacement = 'hosted' | 'local';

const SUPPORTED_HARNESSES: readonly ProvisionHarness[] = ['nanoclaw', 'openclaw'];
const SUPPORTED_PLACEMENTS: readonly ProvisionPlacement[] = ['hosted', 'local'];

export interface CreateProvisionInput {
  /** The DID the new agent will belong to. The route layer must have already verified the caller acts directly as this DID. */
  servingDid: string;
  name: string;
  harness: ProvisionHarness;
  placement: ProvisionPlacement;
  scopes: readonly string[];
  model?: { provider?: string; via?: BrainVia };
  idempotencyKey?: string;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nowIso(): string {
  return new Date().toISOString();
}

/** Directory/handle-safe slug, plus a short random suffix so concurrent same-name provisions don't collide on the global handle-uniqueness constraint. */
function deriveHandle(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 40);
  const suffix = generateId('').slice(1, 7);
  return `${slug || 'agent'}-${suffix}`;
}

export function validateHarness(harness: unknown): asserts harness is ProvisionHarness {
  if (typeof harness !== 'string' || !SUPPORTED_HARNESSES.includes(harness as ProvisionHarness)) {
    throw new ProvisionError(`harness must be one of: ${SUPPORTED_HARNESSES.join(', ')}`, 400);
  }
}

export function validatePlacement(placement: unknown): asserts placement is ProvisionPlacement {
  if (typeof placement !== 'string' || !SUPPORTED_PLACEMENTS.includes(placement as ProvisionPlacement)) {
    throw new ProvisionError(`placement must be one of: ${SUPPORTED_PLACEMENTS.join(', ')}`, 400);
  }
}

/** Reconstruct the pure `ContextEnvelopeInput` this provision's envelope was (or will be) rendered from, purely from stored, non-secret row fields — deterministic, no DB round trip for prose. */
function envelopeInputFromRow(row: Pick<AgentProvisionRow, 'agentDid' | 'servingDid' | 'handle' | 'scopes' | 'model'>): ContextEnvelopeInput {
  if (!row.agentDid) {
    throw new ProvisionError('Provision has no agent identity yet', 409);
  }
  const model = row.model as { provider: string; via: BrainVia };
  return {
    agentDid: row.agentDid,
    ownerDid: row.servingDid,
    handle: row.handle,
    intent: {
      scopes: row.scopes as string[],
      busRoutes: [{ eventType: 'chat.message.received', description: 'Inbound DM dispatch to the runtime.' }],
      brain: {
        placement: 'hosted',
        provider: model.provider,
        via: model.via,
      },
      purpose: `Provisioned via the envelope provisioner (#1933) for ${row.servingDid}.`,
    },
  };
}

/** Full render (file contents included) for a NanoClaw-harness provision — used by the bundle route and the runner, never persisted to the DB row (which keeps only the file-name manifest). */
export function renderEnvelopeForRow(row: AgentProvisionRow): RenderedTree {
  if (row.harness !== 'nanoclaw') {
    throw new ProvisionError(`harness '${row.harness}' is not yet implemented — stub only (#1933 deliverable 4)`, 501);
  }
  const envelope = generateEnvelope(envelopeInputFromRow(row));
  return renderNanoClaw(envelope);
}

async function appendStep(id: string, steps: AgentProvisionStep[], step: AgentProvisionStep, patch: Record<string, unknown> = {}): Promise<AgentProvisionStep[]> {
  const nextSteps = [...steps, step];
  await db.update(agentProvisions).set({ steps: nextSteps, updatedAt: new Date(), ...patch }).where(eq(agentProvisions.id, id));
  return nextSteps;
}

export async function getProvision(id: string): Promise<AgentProvisionRow | null> {
  const [row] = await db.select().from(agentProvisions).where(eq(agentProvisions.id, id)).limit(1);
  return row ?? null;
}

export async function listProvisions(servingDid: string): Promise<AgentProvisionRow[]> {
  return db
    .select()
    .from(agentProvisions)
    .where(eq(agentProvisions.servingDid, servingDid))
    .orderBy(desc(agentProvisions.createdAt));
}

/**
 * Create (or, for a repeated idempotency key, return) a provision. Mutates
 * state through a fixed pipeline (mint identity -> issue grants -> render
 * envelope), persisting `status`/`steps` after every stage so a crash or a
 * thrown error mid-pipeline leaves a legible row rather than nothing at all.
 */
export async function createProvision(input: CreateProvisionInput): Promise<AgentProvisionRow> {
  validateHarness(input.harness);
  validatePlacement(input.placement);
  if (!input.name || typeof input.name !== 'string' || input.name.trim().length === 0) {
    throw new ProvisionError('name is required', 400);
  }

  if (input.idempotencyKey) {
    const [existing] = await db
      .select()
      .from(agentProvisions)
      .where(and(eq(agentProvisions.delegatorDid, input.servingDid), eq(agentProvisions.idempotencyKey, input.idempotencyKey)))
      .limit(1);
    if (existing) return existing;
  }

  const { valid, invalid } = validateIntentScopes(input.scopes);
  if (invalid.length > 0) {
    throw new ProvisionError(`Unknown grant capabilities requested (not in @imajin/auth's GRANT_SCOPE_REGISTRY): ${invalid.join(', ')}`, 400);
  }

  const id = generateId('prov');
  const handle = deriveHandle(input.name);
  const model = { provider: input.model?.provider ?? 'anthropic:claude', via: input.model?.via ?? 'kernel-passthrough' };

  await db.insert(agentProvisions).values({
    id,
    servingDid: input.servingDid,
    delegatorDid: input.servingDid,
    handle,
    displayName: input.name.trim().slice(0, 100),
    harness: input.harness,
    placement: input.placement,
    model,
    scopes: valid,
    status: 'pending',
    steps: [],
    idempotencyKey: input.idempotencyKey ?? null,
  });

  let steps: AgentProvisionStep[] = [];

  // Step 1: identity mint.
  let agentDid: string;
  try {
    const agent = await mintAgentIdentity({ handle, displayName: input.name, actingDid: input.servingDid });
    agentDid = agent.did;
    steps = await appendStep(id, steps, { step: 'mint_identity', status: 'ok', at: nowIso() }, { agentDid, status: 'identity_minted' });
  } catch (err) {
    const message = err instanceof MintAgentIdentityError ? err.message : errorMessage(err);
    await appendStep(id, steps, { step: 'mint_identity', status: 'error', at: nowIso(), error: message }, { status: 'failed' });
    return (await getProvision(id))!;
  }

  // Step 2: issue minimal grants (skipped, not failed, when zero scopes were requested).
  let grantId: string | undefined;
  try {
    if (valid.length > 0) {
      const result = await issueGrant({ delegatorDid: input.servingDid, agentDid, capabilities: valid, audience: { type: 'all' } });
      if ('error' in result) throw new Error(result.error);
      grantId = result.grant.grantId;
      steps = await appendStep(id, steps, { step: 'issue_grants', status: 'ok', at: nowIso() }, { grantId, status: 'grants_issued' });
    } else {
      steps = await appendStep(id, steps, { step: 'issue_grants', status: 'ok', at: nowIso(), error: 'no scopes requested — skipped' }, { status: 'grants_issued' });
    }
  } catch (err) {
    await appendStep(id, steps, { step: 'issue_grants', status: 'error', at: nowIso(), error: errorMessage(err) }, { status: 'failed' });
    return (await getProvision(id))!;
  }

  // Step 3: render the envelope.
  let finalStatus: string;
  try {
    const row = (await getProvision(id))!;
    const rendered = renderEnvelopeForRow(row);
    const manifest: AgentProvisionEnvelopeManifest = {
      files: rendered.files.map((f) => ({ relativePath: f.relativePath })),
      manualSteps: [...rendered.manualSteps],
    };
    finalStatus = input.placement === 'hosted' ? 'awaiting_boot' : 'envelope_rendered';
    steps = await appendStep(id, steps, { step: 'render_envelope', status: 'ok', at: nowIso() }, { envelopeManifest: manifest, status: finalStatus });
  } catch (err) {
    await appendStep(id, steps, { step: 'render_envelope', status: 'error', at: nowIso(), error: errorMessage(err) }, { status: 'failed' });
    return (await getProvision(id))!;
  }

  publish('agent.provisioned', {
    issuer: input.servingDid,
    subject: agentDid,
    scope: 'auth',
    payload: { provisionId: id, agentDid, servingDid: input.servingDid, harness: input.harness, placement: input.placement, status: finalStatus },
  }).catch((err: unknown) => log.error({ err: String(err) }, '[agent-provisioner] bus publish failed (non-fatal)'));

  return (await getProvision(id))!;
}

/** Revoke a provision: revokes its issued grant (if any) and marks the row 'revoked' — revocation is first-class, never a silent DB delete. */
export async function revokeProvision(id: string, requestedBy: string): Promise<{ revoked: boolean } | { error: string; status: number }> {
  const row = await getProvision(id);
  if (!row) return { error: 'Provision not found', status: 404 };
  if (row.servingDid !== requestedBy) {
    return { error: 'Only the owning DID may revoke this provision', status: 403 };
  }
  if (row.status === 'revoked') {
    return { revoked: true };
  }

  if (row.grantId) {
    const result = await revokeGrant({ grantId: row.grantId, requestedBy });
    if ('error' in result) {
      log.error({ err: result.error, provisionId: id, grantId: row.grantId }, '[agent-provisioner] grant revoke failed during provision revoke');
    }
  }

  await db
    .update(agentProvisions)
    .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(agentProvisions.id, id));

  return { revoked: true };
}

/** Runner boot-status callback (#1933 deliverable 2, hosted placement). */
export async function recordBootStatus(id: string, status: 'booted' | 'failed', detail?: string): Promise<AgentProvisionRow | null> {
  const row = await getProvision(id);
  if (!row) return null;
  const steps = [...row.steps, { step: 'boot', status: status === 'booted' ? 'ok' as const : 'error' as const, at: nowIso(), error: detail }];
  await db.update(agentProvisions).set({ status, steps, updatedAt: new Date() }).where(eq(agentProvisions.id, id));
  return getProvision(id);
}
