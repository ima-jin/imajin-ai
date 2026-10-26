/** Metadata/proposal surface: accepts operator input once, never returns it. */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { generateId } from '@/src/lib/kernel/id';
import { actAsRefusal } from '@/src/lib/notify/act-as-guard';
import { getOperatorDid, isOperatorIdentity, computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { recordApprovalRequested } from '@/src/lib/notify/operator-approvals-service';
import { listOperatorAppSecrets, hasClaimedApp, previewAppSecrets, withPendingSecretSync } from '@/src/lib/apps/secrets-operator';
import { APP_SECRET_ACTIONS, appSecretsKind, type AppSecretAction } from '@/src/lib/apps/secrets-kind';
import { validateSecrets } from '@/src/lib/apps/secret-declarations';
import { isAppSecretValue, stageAppSecret } from '@/src/lib/apps/secret-staging';
import { publicAppSecrets } from '@/src/lib/apps/secrets-metadata';
import { newSecretDeclarations, SECRET_REFRESH_NOTICE } from '@/src/lib/apps/declarations-approval';

export const dynamic = 'force-dynamic';

async function authorize(request: NextRequest, write = false) {
  const cors = new Headers(corsHeaders(request));
  cors.set('Cache-Control', 'no-store');
  const auth = await requireAuth(request);
  if ('error' in auth) return { response: NextResponse.json({ error: auth.error }, { status: auth.status, headers: cors }) };
  if (write) {
    const refusal = actAsRefusal(auth.identity, cors);
    if (refusal) return { response: refusal };
  }
  const operatorDid = await getOperatorDid();
  if (!operatorDid || !isOperatorIdentity(auth.identity, operatorDid)) {
    return { response: NextResponse.json({ error: 'Node operator required' }, { status: 403, headers: cors }) };
  }
  return { operatorDid, cors };
}

export async function GET(request: NextRequest) {
  const auth = await authorize(request);
  if (auth.response) return auth.response;
  try {
    const apps = (await listOperatorAppSecrets()).map(publicAppSecrets);
    return NextResponse.json({ apps }, { headers: auth.cors });
  } catch {
    return NextResponse.json({ error: 'App-secret metadata unavailable' }, { status: 503, headers: auth.cors });
  }
}

function validateBody(body: Record<string, unknown>): string | null {
  if (Object.keys(body).some((key) => !['appDid', 'action', 'name', 'value'].includes(key))) return 'Invalid app-secret proposal';
  if (typeof body.appDid !== 'string' || !body.appDid || !APP_SECRET_ACTIONS.includes(body.action as AppSecretAction)) return 'appDid and a sync, set, rotate or revoke action are required';
  if (body.action === 'sync' && body.name !== undefined) return 'Sync accepts no secret name';
  if ((body.action === 'sync' || body.action === 'revoke') && body.value !== undefined) return 'Operator input not accepted for this action';
  return null;
}

type ProposalDetail = { detail: Record<string, unknown> } | { error: string; status?: number };

async function prepareSyncDetail(
  app: { slug: string | null; secrets: unknown }, detail: Record<string, unknown>,
): Promise<ProposalDetail> {
  if (!app.slug) return { error: 'App has no manifest repo slug', status: 409 };
  const snapshot = await previewAppSecrets(app.slug);
  if ('error' in snapshot) return { error: snapshot.error, status: 409 };
  const current = validateSecrets(app.secrets ?? []);
  if ('error' in current) return { error: 'Registered secret declarations are invalid', status: 409 };
  const { additions, notApplied } = newSecretDeclarations(current.ok, snapshot.ok);
  const notice = [...notApplied, SECRET_REFRESH_NOTICE].join('. ');
  if (additions.length === 0) return { error: `No new secret declarations. Not applied: ${notice}`, status: 409 };
  const merged = validateSecrets([...current.ok, ...additions]);
  if ('error' in merged) return { error: merged.error, status: 409 };
  return { detail: { ...detail, slug: app.slug, secrets: additions, notApplied: notice } };
}

async function prepareDetail(
  body: Record<string, unknown>,
  app: { name: string; slug: string | null; secrets: unknown },
  proposalId: string, operatorDid: string,
): Promise<ProposalDetail> {
  const appDid = body.appDid as string;
  const action = body.action as AppSecretAction;
  const detail: Record<string, unknown> = { appDid, appName: app.name };
  if (action === 'sync') return prepareSyncDetail(app, detail);
  const declared = validateSecrets(app.secrets ?? []);
  if ('error' in declared || typeof body.name !== 'string') return { error: 'Secret is not declared for this app' };
  const declaration = declared.ok.find((secret) => secret.name === body.name);
  if (!declaration) return { error: 'Secret is not declared for this app' };
  detail.name = body.name;
  if (declaration.kind === 'operator-supplied' && (action === 'set' || action === 'rotate')) {
    if (!isAppSecretValue(body.value)) return { error: 'Operator input must be a nonempty string of at most 65536 UTF-8 bytes' };
    detail.stagingRef = await stageAppSecret({
      proposalId, operatorDid, appDid, name: body.name, action,
    }, body.value);
  } else if (body.value !== undefined || action === 'set') {
    return { error: 'Operator input not accepted for this action' };
  }
  return { detail };
}

export async function POST(request: NextRequest) {
  const auth = await authorize(request, true);
  if (auth.response) return auth.response;
  const fail = (error: string, status = 400) => NextResponse.json({ error }, { status, headers: auth.cors });
  let body: Record<string, unknown>;
  try {
    const raw: unknown = await request.json();
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Invalid proposal');
    body = raw as Record<string, unknown>;
  } catch { return fail('Invalid JSON'); }
  const invalid = validateBody(body);
  if (invalid) return fail(invalid);
  const appDid = body.appDid as string;
  const action = body.action as AppSecretAction;
  try {
    const [app] = await db.select({
      name: registryApps.name, slug: registryApps.slug, status: registryApps.status, secrets: registryApps.secrets,
    }).from(registryApps).where(eq(registryApps.appDid, appDid));
    if (!app) return fail('Unknown app', 404);
    if (app.status !== 'active' || !(await hasClaimedApp(appDid))) return fail('App must be active and claimed', 409);
    const create = async () => {
      const proposalId = generateId('appsecret');
      const prepared = await prepareDetail(body, app, proposalId, auth.operatorDid);
      if ('error' in prepared) throw new ProposalValidationError(prepared.error, prepared.status);
      const { detail } = prepared;
      const kind = appSecretsKind(action);
      const summary = action === 'sync' ? `'${app.name}' declares new secrets` : `${action} app secrets for '${app.name}'`;
      const contentHash = computeApprovalContentHash({ proposalId, source: 'apps', kind, summary, keysTouched: [], detail });
      await recordApprovalRequested({
        proposalId, operatorDid: auth.operatorDid, source: 'apps', kind, summary, keysTouched: [],
        detail, contentHash, notificationId: null, signerDid: auth.operatorDid,
      });
      return proposalId;
    };
    const proposalId = action === 'sync'
      ? await withPendingSecretSync(appDid, auth.operatorDid, create)
      : await create();
    return NextResponse.json({ status: 'pending', proposalId }, { status: 201, headers: auth.cors });
  } catch (error) {
    if (error instanceof ProposalValidationError) return fail(error.message, error.status);
    return fail('App-secret proposal unavailable', 503);
  }
}
class ProposalValidationError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
