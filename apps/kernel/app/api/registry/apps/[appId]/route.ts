import { NextRequest, NextResponse } from 'next/server';
import { db, registryApps } from '@/src/db';
import { eq } from 'drizzle-orm';
import { requireAuth, resolveActingDid, approvedScopeCeiling, type AppDependency } from '@imajin/auth';
import { validateAppDeclarations, DEPENDS_ON_OPERATOR_ONLY_ERROR } from '@/src/lib/kernel/app-declarations';
import { EMITTABLE_EVENTS_OPERATOR_ONLY_ERROR } from '@/src/lib/kernel/emittable-events';
import { enforceRoutePolicy } from '@imajin/auth/delegation-policy';

// GET /api/registry/apps/:appId — app detail (public)
export async function GET(_request: NextRequest, props: { params: Promise<{ appId: string }> }) {
  const params = await props.params;
  const [app] = await db
    .select({
      id: registryApps.id,
      ownerDid: registryApps.ownerDid,
      name: registryApps.name,
      description: registryApps.description,
      appDid: registryApps.appDid,
      publicKey: registryApps.publicKey,
      callbackUrl: registryApps.callbackUrl,
      homepageUrl: registryApps.homepageUrl,
      logoUrl: registryApps.logoUrl,
      requestedScopes: registryApps.requestedScopes,
      providesScopes: registryApps.providesScopes,
      dependsOn: registryApps.dependsOn,
      emittableEvents: registryApps.emittableEvents,
      status: registryApps.status,
      createdAt: registryApps.createdAt,
      updatedAt: registryApps.updatedAt,
    })
    .from(registryApps)
    .where(eq(registryApps.id, params.appId));

  if (!app) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json(app);
}

type AppUpdates = Partial<typeof registryApps.$inferInsert>;

/** The plain, unvalidated owner-editable fields of PATCH. */
function buildFieldUpdates(body: Record<string, unknown>): AppUpdates {
  const updates: AppUpdates = { updatedAt: new Date() };
  if (typeof body.name === 'string' && body.name.trim()) updates.name = body.name.trim();
  if (typeof body.description === 'string') updates.description = body.description || null;
  if (typeof body.callbackUrl === 'string' && body.callbackUrl) updates.callbackUrl = body.callbackUrl;
  if (typeof body.homepageUrl === 'string') updates.homepageUrl = body.homepageUrl || null;
  if (typeof body.logoUrl === 'string') updates.logoUrl = body.logoUrl || null;
  if (Array.isArray(body.requestedScopes)) updates.requestedScopes = body.requestedScopes;
  return updates;
}

/** The row's assignment as it stood BEFORE this request — never the request body. */
interface ExistingAssignment {
  slug: string | null;
  requestedScopes: string[] | null;
  providesScopes: string[];
  dependsOn: AppDependency[];
}

/**
 * #2674: the approved list is the ceiling. An app registered through
 * `apps.provision` had its `providesScopes` / `dependsOn` approved on the /jin
 * card, and that list is recorded in the row (`requestedScopes` + the declarations
 * themselves). A later PATCH may narrow it but never widen it, so an edit made
 * after approval can't hand the app a scope the operator never saw.
 *
 * The ceiling is computed from the stored row, not the request body, so a single
 * PATCH can't raise `requestedScopes` and spend the new headroom on `providesScopes`.
 */
function beyondApprovedList(scopes: readonly string[], existing: ExistingAssignment): string[] {
  const ceiling = approvedScopeCeiling(existing);
  return scopes.filter((s) => !ceiling.has(s));
}

/**
 * #2663: validate and collect `providesScopes` — only when the request actually
 * sent it. (`dependsOn` is operator-only and never reaches here: PATCH rejects it.)
 */
async function buildDeclarationUpdates(
  body: Record<string, unknown>,
  existing: ExistingAssignment,
): Promise<{ ok: Pick<AppUpdates, 'providesScopes'> } | { error: string }> {
  if (body.providesScopes === undefined) return { ok: {} };

  const declarations = await validateAppDeclarations({ providesScopes: body.providesScopes, slug: existing.slug });
  if ('error' in declarations) return { error: declarations.error };

  const over = beyondApprovedList(declarations.ok.providesScopes, existing);
  if (over.length > 0) {
    return { error: `providesScopes beyond the approved list (it can be narrowed, not widened): ${over.join(', ')}` };
  }
  return { ok: { providesScopes: declarations.ok.providesScopes } };
}

/**
 * #2674: for an app with a slug (one an operator provisioned), `requestedScopes`
 * is part of the approved record, so PATCH may narrow it but not widen it.
 * Slug-less self-service apps keep editing their own request list freely.
 */
function checkRequestedScopesCeiling(
  body: Record<string, unknown>,
  existing: ExistingAssignment,
): string | null {
  if (!existing.slug || !Array.isArray(body.requestedScopes)) return null;
  const over = beyondApprovedList(body.requestedScopes.map(String), existing);
  return over.length > 0 ? `requestedScopes beyond the approved list (it can be narrowed, not widened): ${over.join(', ')}` : null;
}

// PATCH /api/registry/apps/:appId — update (owner only)
export async function PATCH(request: NextRequest, props: { params: Promise<{ appId: string }> }) {
  const params = await props.params;
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { identity } = authResult;

  const [existing] = await db
    .select({
      id: registryApps.id,
      ownerDid: registryApps.ownerDid,
      slug: registryApps.slug,
      requestedScopes: registryApps.requestedScopes,
      providesScopes: registryApps.providesScopes,
      dependsOn: registryApps.dependsOn,
    })
    .from(registryApps)
    .where(eq(registryApps.id, params.appId));

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (existing.ownerDid !== resolveActingDid(identity)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // #2663: `dependsOn` grants an app's tokens another service's audience (e.g.
  // kernel media), so an app owner may not self-assign it — only an operator
  // path (admin route, `apps.provision` with the /jin card approval) writes it.
  if (body.dependsOn !== undefined) {
    return NextResponse.json({ error: DEPENDS_ON_OPERATOR_ONLY_ERROR }, { status: 400 });
  }
  // #2638/#2641: which event types an app may emit is an operator approval, never self-assigned.
  if (body.emittableEvents !== undefined) {
    return NextResponse.json({ error: EMITTABLE_EVENTS_OPERATOR_ONLY_ERROR }, { status: 400 });
  }

  const requestedScopesError = checkRequestedScopesCeiling(body, existing);
  if (requestedScopesError) {
    return NextResponse.json({ error: requestedScopesError }, { status: 400 });
  }

  const updates = buildFieldUpdates(body);

  // #2663: the app's own scopes — same assignment model as requestedScopes,
  // validated the same way the register route validates them (#2674: and capped
  // by the approved list).
  const declarationUpdates = await buildDeclarationUpdates(body, existing);
  if ('error' in declarationUpdates) {
    return NextResponse.json({ error: declarationUpdates.error }, { status: 400 });
  }
  Object.assign(updates, declarationUpdates.ok);

  const [updated] = await db
    .update(registryApps)
    .set(updates)
    .where(eq(registryApps.id, params.appId))
    .returning();

  return NextResponse.json(updated);
}

// DELETE /api/registry/apps/:appId — soft revoke (owner only)
export async function DELETE(request: NextRequest, props: { params: Promise<{ appId: string }> }) {
  const params = await props.params;
  const authResult = await requireAuth(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { identity } = authResult;
  const delegationDenied = enforceRoutePolicy(identity, 'kernel.registry-app.delete', { resourceId: params.appId });
  if (delegationDenied) return delegationDenied;

  const [existing] = await db
    .select({ id: registryApps.id, ownerDid: registryApps.ownerDid })
    .from(registryApps)
    .where(eq(registryApps.id, params.appId));

  if (!existing) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }
  if (existing.ownerDid !== resolveActingDid(identity)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  await db
    .update(registryApps)
    .set({ status: 'revoked', revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(registryApps.id, params.appId));

  return NextResponse.json({ ok: true });
}
