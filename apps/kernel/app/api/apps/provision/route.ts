/**
 * POST /api/apps/provision — propose `apps.provision` (#2375) on the
 * existing operator-approvals rail (#2059/#2152/#2082). Gate 1+2 of epic
 * #2370: creates an extracted app's GitHub repo, registers it in
 * `registry.apps` (#1990) as a new `tier: 'third_party'` row, and seals its
 * app-auth private key + a GitHub-Packages-read token into the repo's
 * Actions secrets.
 *
 * Any authenticated identity may PROPOSE (mirrors the GitHub connector's
 * "agent proposes, operator approves" posture — contrast
 * `POST /jin/api/vault-proposals`, which is operator-only-raise). Nothing
 * external happens until the operator countersigns an 'approve' decision
 * via the existing `POST /api/operator-approvals/:id/decision` route,
 * which invokes `executeAppsProvisionApproval` — see
 * `src/lib/apps/approvals-execution.ts`.
 *
 * Idempotent on `slug`:
 *   - An already-`succeeded` slug returns the cached `{repoUrl, appDid,
 *     secretsSet}` immediately — no new proposal, nothing re-created.
 *   - An already-`pending` proposal for the same slug is reused rather
 *     than raising a duplicate card.
 *
 * GET /api/apps/provision?slug= — poll the current ledger row so the
 * proposing agent can retrieve the eventual result without needing the
 * operator's decision response.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { generateId } from '@/src/lib/kernel/id';
import { getOperatorDid, computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { recordApprovalRequested } from '@/src/lib/notify/operator-approvals-service';
import { findPendingAppsProvisionProposal } from '@/src/lib/apps/provision-proposals';
import { APPS_SOURCE, APPS_PROVISION_KIND } from '@/src/lib/apps/approvals-execution';
import { getAppProvisionStatus } from '@/src/lib/apps/provision';

const log = createLogger('kernel:apps-provision-route');

export const dynamic = 'force-dynamic';

const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,38}$/;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_TEMPLATE_LENGTH = 200;
const MAX_ATTESTATION_TYPES = 20;

interface ProvisionRequestBody {
  slug?: unknown;
  displayName?: unknown;
  template?: unknown;
  attestationTypes?: unknown;
  /**
   * #2411: when true, an already-`succeeded` slug is NOT short-circuited
   * with the cached result — a new `apps:provision` proposal is raised
   * (and, once approved, `runAppProvision`'s idempotent-succeeded branch
   * issues a FRESH one-time claim code, reusing the existing grant/key/
   * repo). This is the operator's lever to recover a lost or expired app
   * signing-key claim code without re-minting anything.
   */
  reissueClaim?: unknown;
}

type ValidatedBody = { slug: string; displayName: string; template: string | null; attestationTypes: string[]; reissueClaim: boolean };

function validateBody(body: ProvisionRequestBody): { ok: true; value: ValidatedBody } | { ok: false; error: string } {
  if (typeof body.slug !== 'string' || !SLUG_PATTERN.test(body.slug)) {
    return { ok: false, error: 'slug must be a lowercase, hyphenated identifier (e.g. \'dykil\')' };
  }
  if (typeof body.displayName !== 'string' || body.displayName.trim().length === 0 || body.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    return { ok: false, error: `displayName is required (max ${MAX_DISPLAY_NAME_LENGTH} chars)` };
  }
  if (body.template !== undefined && (typeof body.template !== 'string' || body.template.length > MAX_TEMPLATE_LENGTH)) {
    return { ok: false, error: `template must be a string of at most ${MAX_TEMPLATE_LENGTH} chars` };
  }
  if (body.attestationTypes !== undefined) {
    if (!Array.isArray(body.attestationTypes) || body.attestationTypes.length > MAX_ATTESTATION_TYPES) {
      return { ok: false, error: `attestationTypes must be an array of at most ${MAX_ATTESTATION_TYPES} strings` };
    }
    if (!body.attestationTypes.every((t) => typeof t === 'string' && t.length > 0)) {
      return { ok: false, error: 'attestationTypes must contain only non-empty strings' };
    }
  }

  return {
    ok: true,
    value: {
      slug: body.slug,
      displayName: body.displayName.trim(),
      template: typeof body.template === 'string' ? body.template : null,
      attestationTypes: Array.isArray(body.attestationTypes) ? (body.attestationTypes as string[]) : [],
      reissueClaim: body.reissueClaim === true,
    },
  };
}

export async function POST(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }
  const proposedByDid = resolveActingDid(authResult.identity);

  let body: ProvisionRequestBody;
  try {
    body = (await request.json()) as ProvisionRequestBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const validation = validateBody(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400, headers: cors });
  }
  const { slug, displayName, template, attestationTypes, reissueClaim } = validation.value;

  // Idempotent on slug: an already-succeeded provision returns the cached
  // result immediately — no new proposal, nothing re-created — UNLESS the
  // caller explicitly asked to reissue the app-signing-key claim code
  // (#2411), in which case a fresh proposal is raised anyway so the
  // operator's approval mints a new one-time code.
  const existingRun = await getAppProvisionStatus(slug);
  if (existingRun?.status === 'succeeded' && !reissueClaim) {
    return NextResponse.json(
      {
        status: 'succeeded',
        slug,
        appDid: existingRun.appDid,
        repoUrl: existingRun.repoUrl,
        secretsSet: existingRun.secretsSet,
      },
      { headers: cors },
    );
  }

  // Reuse an already-pending proposal for the same slug rather than raising a duplicate card.
  const pending = await findPendingAppsProvisionProposal(slug);
  if (pending) {
    return NextResponse.json({ status: 'pending', proposalId: pending.proposalId }, { headers: cors });
  }

  const operatorDid = await getOperatorDid();
  if (!operatorDid) {
    return NextResponse.json(
      { error: 'No node operator is configured — apps.provision requires an operator-authority decision' },
      { status: 500, headers: cors },
    );
  }

  const proposalId = generateId('appprov');
  const summary = `Provision app '${slug}' (${displayName}): create ima-jin/${slug} from template, register it, and seal its credential.`;
  const detail: Record<string, unknown> = { slug, displayName, template, attestationTypes };
  const contentHash = computeApprovalContentHash({
    proposalId,
    source: APPS_SOURCE,
    kind: APPS_PROVISION_KIND,
    summary,
    keysTouched: [],
    detail,
  });

  try {
    await recordApprovalRequested({
      proposalId,
      operatorDid,
      source: APPS_SOURCE,
      kind: APPS_PROVISION_KIND,
      summary,
      keysTouched: [],
      detail,
      contentHash,
      notificationId: null,
      signerDid: proposedByDid,
    });
    return NextResponse.json({ status: 'pending', proposalId }, { status: 201, headers: cors });
  } catch (err) {
    log.error({ err: String(err), slug, proposedByDid }, 'Failed to record apps.provision proposal');
    return NextResponse.json({ error: 'Failed to raise apps.provision proposal' }, { status: 500, headers: cors });
  }
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const { searchParams } = new URL(request.url);
  const slug = searchParams.get('slug');
  if (!slug) {
    return NextResponse.json({ error: 'slug query parameter is required' }, { status: 400, headers: cors });
  }

  const row = await getAppProvisionStatus(slug);
  if (!row) {
    return NextResponse.json({ error: `No apps.provision run found for slug '${slug}'` }, { status: 404, headers: cors });
  }

  return NextResponse.json(
    {
      slug: row.slug,
      status: row.status,
      appDid: row.appDid,
      repoUrl: row.repoUrl,
      secretsSet: row.secretsSet,
      attestationTypes: row.attestationTypes,
      failedStep: row.failedStep,
      errorMessage: row.errorMessage,
      updatedAt: row.updatedAt,
    },
    { headers: cors },
  );
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
