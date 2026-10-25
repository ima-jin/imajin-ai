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
 *     secretsSet}` immediately — unless an explicit domain requests a new
 *     countersigned retry of host issuance; no repo/identity is re-created.
 *   - An already-`pending` proposal for the same slug is reused rather
 *     than raising a duplicate card.
 *
 * Reissue guard (#2745): `reissueClaim: true` for a slug with no `succeeded`
 * run is refused with 409 `nothing to reissue for <slug>` — it must never fall
 * through to a full fresh provision (which would mint + vault-seal a key).
 *
 * GET /api/apps/provision?slug= — poll the current ledger row so the
 * proposing agent can retrieve the eventual result without needing the
 * operator's decision response.
 *
 * GET /api/apps/provision?status=succeeded — operator-only list of succeeded
 * provisions, each flagged `claimed`, so /jin can keep offering "Reissue claim
 * code" for unclaimed apps after a reload (#2745). A non-operator gets
 * `{ isOperator: false, provisions: [] }`.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, resolveActingDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { generateId } from '@/src/lib/kernel/id';
import { getOperatorDid, isOperatorIdentity, computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { recordApprovalRequested } from '@/src/lib/notify/operator-approvals-service';
import { findPendingAppsProvisionProposal } from '@/src/lib/apps/provision-proposals';
import { APPS_SOURCE, APPS_PROVISION_KIND } from '@/src/lib/apps/approvals-execution';
import { getAppProvisionStatus, getProvisionSignInAudience } from '@/src/lib/apps/provision';
import { listSucceededAppProvisions } from '@/src/lib/apps/provision-list';
import { previewManifestDeclarations } from '@/src/lib/apps/manifest-preview';
import { isAppVisibility } from '@/src/lib/apps/visibility';
import { isRepositoryName } from '@/src/lib/apps/template-lineage';
import { isAppSignInAudience } from '@/src/lib/apps/sign-in-audience';

import { validateDomainChoice } from '@/src/lib/apps/domain-choice';

const log = createLogger('kernel:apps-provision-route');

export const dynamic = 'force-dynamic';

const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,38}$/;
const MAX_DISPLAY_NAME_LENGTH = 200;
const MAX_TEMPLATE_LENGTH = 200;
const MAX_ATTESTATION_TYPES = 20;

interface ProvisionRequestBody {
  signInAudience?: unknown;
  visibility?: unknown;
  siteOwnerDid?: unknown;
  domain?: unknown;
  slug?: unknown;
  displayName?: unknown;
  template?: unknown;
  sourceRepo?: unknown;
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

async function succeededChoiceError(existingRun: Awaited<ReturnType<typeof getAppProvisionStatus>>, body: ProvisionRequestBody, sourceRepo?: string): Promise<string | null> {
  if (changesSucceededSource(existingRun, sourceRepo)) return 'An already-provisioned app cannot change sourceRepo';
  if (existingRun?.status !== 'succeeded' || body.signInAudience === undefined) return null;
  return await getProvisionSignInAudience(existingRun.appDid) === body.signInAudience
    ? null : 'An already-provisioned app cannot change signInAudience through provisioning; use the owner settings';
}

function isProvisionBody(body: unknown): body is ProvisionRequestBody {
  return !!body && typeof body === 'object' && !Array.isArray(body);
}

function withProvisionAudience(body: ProvisionRequestBody, status?: string): ProvisionRequestBody {
  if (status === 'succeeded') return body;
  return { ...body, signInAudience: body.signInAudience === undefined ? 'members' : body.signInAudience };
}

async function pendingProvisionResponse(slug: string, body: ProvisionRequestBody, reissueClaim: boolean, retryDomain: boolean, cors: Record<string, string>): Promise<Response | null> {
  const pending = await findPendingAppsProvisionProposal(slug);
  if (!pending) return null;
  if (!reissueClaim && !retryDomain && (pending.detail?.signInAudience ?? 'members') !== body.signInAudience) {
    return NextResponse.json({ error: 'A pending provision has a different signInAudience; withdraw it before re-proposing' }, { status: 409, headers: cors });
  }
  return NextResponse.json({ status: 'pending', proposalId: pending.proposalId }, { headers: cors });
}

type ValidatedBody = { slug: string; displayName: string; template: string | null; sourceRepo?: string; attestationTypes: string[]; reissueClaim: boolean };

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
      ...(isRepositoryName(body.sourceRepo) ? { sourceRepo: body.sourceRepo } : {}),
      attestationTypes: Array.isArray(body.attestationTypes) ? (body.attestationTypes as string[]) : [],
      reissueClaim: body.reissueClaim === true,
    },
  };
}

function provisionDetail(
  body: ProvisionRequestBody,
  base: Record<string, unknown>,
  reissueClaim: boolean,
): Record<string, unknown> {
  const detail = { ...base };
  if (body.siteOwnerDid) detail.siteOwnerDid = body.siteOwnerDid;
  if (body.domain) detail.domain = body.domain;
  if (isRepositoryName(body.sourceRepo)) detail.sourceRepo = body.sourceRepo;
  if (reissueClaim) detail.reissueClaim = true;
  else {
    detail.visibility = body.visibility ?? 'public';
    if (body.signInAudience !== undefined) detail.signInAudience = body.signInAudience;
  }
  return detail;
}

function isDomainRetry(status: string | undefined, domain: unknown): boolean {
  return status === 'succeeded' && typeof domain === 'string';
}
function changesSucceededSource(existingRun: Awaited<ReturnType<typeof getAppProvisionStatus>>, sourceRepo?: string): boolean {
  return existingRun?.status === 'succeeded' && sourceRepo !== undefined
    && existingRun.repoUrl?.toLowerCase() !== `https://github.com/${sourceRepo}`.toLowerCase();
}

async function previewProvisionDeclarations(skip: boolean, slug: string, template: string | null, sourceRepo?: string) {
  if (skip) return { ok: null };
  return sourceRepo
    ? previewManifestDeclarations(slug, template ?? undefined, sourceRepo)
    : previewManifestDeclarations(slug, template ?? undefined);
}

function provisionSummary(body: ProvisionRequestBody, slug: string, displayName: string, operatorDid: string, reissueClaim: boolean, retryAppDid?: string | null): string {
  if (reissueClaim) {
    return `Reissue the claim code for app '${slug}' (${displayName}): issue a fresh one-time app-signing-key claim code; nothing is re-created.`;
  }
  const siteOwnerDid = typeof body.siteOwnerDid === 'string' ? body.siteOwnerDid : operatorDid;
  const domain = typeof body.domain === 'string' ? body.domain : `${slug}.imajin.ai`;
  const visibility = isAppVisibility(body.visibility) ? body.visibility : 'public';
  const signInAudience = isAppSignInAudience(body.signInAudience) ? body.signInAudience : 'members';
  if (retryAppDid) {
    return `Retry domain issuance for existing app '${slug}' (${retryAppDid}) at ${domain} using its recorded registry owner, then reissue its claim code. No repo, keypair or owner is re-created or changed.`;
  }
  const repositoryAction = isRepositoryName(body.sourceRepo)
    ? `use existing repository ${body.sourceRepo} (no repository is created), register it, and seal its credential`
    : `create ima-jin/${slug} from template, register it, and seal its credential`;
  return `Provision app '${slug}' (${displayName}): ${repositoryAction}. Visibility: ${visibility}. Sign-in audience: ${signInAudience}. Site owner: ${siteOwnerDid}; issue ${domain} from Imajin's organization. Will retire app_first_party_${slug} if it holds the slug or active audience; no app schema/data is changed.`;
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
  if (!isProvisionBody(body)) {
    return NextResponse.json({ error: 'Body must be an object' }, { status: 400, headers: cors });
  }

  const validation = validateBody(body);
  const domainChoiceError = validateDomainChoice(body);
  if (domainChoiceError) return NextResponse.json({ error: domainChoiceError }, { status: 400, headers: cors });
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400, headers: cors });
  }
  const { slug, displayName, template, sourceRepo, attestationTypes, reissueClaim } = validation.value;

  // Idempotent on slug: an already-succeeded provision returns the cached
  // result immediately — no new proposal, nothing re-created — UNLESS the
  // caller explicitly requests a domain retry or the app-signing-key claim code
  // (#2411), in which case a fresh proposal is raised anyway so the
  // operator's approval mints a new one-time code.
  const existingRun = await getAppProvisionStatus(slug);
  const choiceError = await succeededChoiceError(existingRun, body, sourceRepo);
  if (choiceError) return NextResponse.json({ error: choiceError }, { status: 409, headers: cors });
  // Fresh provisions bind the safe default into the card hash. Reissues and
  // succeeded-run retries omit it, so they cannot silently reset live settings.
  body = withProvisionAudience(body, existingRun?.status);
  // #2745: a reissue only makes sense for an app that was actually provisioned. Refuse before
  // anything else (no pending-proposal reuse, no manifest read, no proposal row) so it can never
  // turn into a fresh provision.
  if (reissueClaim && existingRun?.status !== 'succeeded') {
    return NextResponse.json({ error: `nothing to reissue for ${slug}` }, { status: 409, headers: cors });
  }
  const retryDomain = isDomainRetry(existingRun?.status, body.domain);
  if (existingRun?.status === 'succeeded' && !reissueClaim && !retryDomain) {
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
  const pendingResponse = await pendingProvisionResponse(slug, body, reissueClaim, retryDomain, cors);
  if (pendingResponse) return pendingResponse;

  const operatorDid = await getOperatorDid();
  if (!operatorDid) {
    return NextResponse.json(
      { error: 'No node operator is configured — apps.provision requires an operator-authority decision' },
      { status: 500, headers: cors },
    );
  }

  // #2663: read the app's `providesScopes` / `dependsOn` from imajin.app.json NOW,
  // so the operator sees (and, by signing the card, approves) exactly that list.
  // An unreadable/invalid manifest blocks a fresh proposal, never approving [].
  // #2707: a reissue never re-registers anything (the succeeded branch of `runAppProvision`
  // only retries an explicit host, re-grants + issues a code), so it carries no declarations and needs no manifest read.
  // A reissue is only ever raised for a `succeeded` ledger row (#2745 guard above).
  const preview = await previewProvisionDeclarations(reissueClaim || retryDomain, slug, template, sourceRepo);
  if ('error' in preview) {
    return NextResponse.json(
      { error: preview.error },
      { status: 400, headers: cors },
    );
  }

  const proposalId = generateId('appprov');
  // #2707: a reissue is flagged on the card itself (and so covered by the content hash the
  // operator signs) so /jin can say "Reissue claim code" instead of "Provision". Only set
  // when true — an ordinary provision proposal carries the retirement notice instead.
  const summary = provisionSummary(body, slug, displayName, operatorDid, reissueClaim, retryDomain ? existingRun?.appDid : null);
  const detail = provisionDetail(body, {
    slug, displayName, template, attestationTypes, manifestDeclarations: preview.ok,
  }, reissueClaim);
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

async function listSucceededForOperator(identity: Parameters<typeof isOperatorIdentity>[0], cors: Record<string, string>) {
  const operatorDid = await getOperatorDid();
  if (!operatorDid || !isOperatorIdentity(identity, operatorDid)) {
    return NextResponse.json({ isOperator: false, provisions: [] }, { headers: cors });
  }
  const rows = await listSucceededAppProvisions();
  return NextResponse.json(
    {
      isOperator: true,
      provisions: rows.map((row) => ({
        slug: row.slug,
        appDid: row.appDid,
        repoUrl: row.repoUrl,
        claimed: row.claimed,
        updatedAt: row.updatedAt,
      })),
    },
    { headers: { ...cors, 'Cache-Control': 'no-store' } },
  );
}

export async function GET(request: NextRequest) {
  const cors = corsHeaders(request);

  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status, headers: cors });
  }

  const { searchParams } = new URL(request.url);
  const slug = searchParams.get('slug');
  if (!slug && searchParams.get('status') === 'succeeded') {
    return listSucceededForOperator(authResult.identity, cors);
  }
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
