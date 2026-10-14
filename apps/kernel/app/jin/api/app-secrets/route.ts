/** Metadata and proposal-only operator surface. No plaintext or fetch action. */
import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@imajin/auth';
import { eq } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { corsHeaders } from '@/src/lib/kernel/cors';
import { generateId } from '@/src/lib/kernel/id';
import { actAsRefusal } from '@/src/lib/notify/act-as-guard';
import { getOperatorDid, isOperatorIdentity, computeApprovalContentHash } from '@/src/lib/notify/operator-approvals';
import { recordApprovalRequested } from '@/src/lib/notify/operator-approvals-service';
import { listOperatorAppSecrets, hasClaimedApp, previewAppSecrets } from '@/src/lib/apps/secrets-operator';
import { APP_SECRET_ACTIONS, appSecretsKind, type AppSecretAction } from '@/src/lib/apps/secrets-kind';
import { validateSecrets } from '@/src/lib/apps/secret-declarations';

export const dynamic = 'force-dynamic';

async function authorize(request: NextRequest, write = false) {
  const cors = corsHeaders(request);
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
    return NextResponse.json({ apps: await listOperatorAppSecrets() }, { headers: auth.cors });
  } catch {
    return NextResponse.json({ error: 'App-secret metadata unavailable' }, { status: 503, headers: auth.cors });
  }
}

function validateBody(body: Record<string, unknown>): string | null {
  if (Object.keys(body).some((key) => !['appDid', 'action', 'name'].includes(key))) return 'Only appDid, action and name are accepted';
  if (typeof body.appDid !== 'string' || !body.appDid || !APP_SECRET_ACTIONS.includes(body.action as AppSecretAction)) return 'appDid and a sync, rotate or revoke action are required';
  if (body.action === 'sync' && body.name !== undefined) return 'Sync accepts no secret name';
  return null;
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
    const detail: Record<string, unknown> = { appDid, appName: app.name };
    if (action === 'sync') {
      if (!app.slug) return fail('App has no manifest repo slug', 409);
      const snapshot = await previewAppSecrets(app.slug);
      if ('error' in snapshot) return fail(snapshot.error, 409);
      detail.slug = app.slug;
      detail.secrets = snapshot.ok;
    } else {
      const declared = validateSecrets(app.secrets ?? []);
      if ('error' in declared || typeof body.name !== 'string' || !declared.ok.some((secret) => secret.name === body.name)) return fail('Secret is not declared for this app');
      detail.name = body.name;
    }
    const proposalId = generateId('appsecret');
    const kind = appSecretsKind(action);
    const summary = `${action} app secrets for '${app.name}'`;
    const contentHash = computeApprovalContentHash({ proposalId, source: 'apps', kind, summary, keysTouched: [], detail });
    await recordApprovalRequested({
      proposalId, operatorDid: auth.operatorDid, source: 'apps', kind, summary, keysTouched: [],
      detail, contentHash, notificationId: null, signerDid: auth.operatorDid,
    });
    return NextResponse.json({ status: 'pending', proposalId }, { status: 201, headers: auth.cors });
  } catch {
    return fail('App-secret proposal unavailable', 503);
  }
}

export { corsOptions as OPTIONS } from '@/src/lib/kernel/cors';
