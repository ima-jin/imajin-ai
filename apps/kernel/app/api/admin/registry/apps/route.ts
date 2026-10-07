/**
 * Admin app-registry surface (#1990): list every registry.apps row and
 * register a new one with the fields self-service registration
 * (`POST /api/registry/apps`) never exposes — `tier`, `allowedRedirectHosts`,
 * `tokenAudiences` — so an operator can register a first-party app, or grant
 * a third-party app additional redirect hosts / token audiences.
 *
 * Every mutation here is admin-scoped (`requireAdmin`) and mints a signed
 * `registry.app.registered` attestation (@imajin/auth's `emitAttestation`,
 * signed with AUTH_PRIVATE_KEY) — the same signed-audit-trail primitive
 * every other admin mutation in this codebase relies on, publishing the
 * generic `attestation.created` bus event.
 */
import { NextRequest, NextResponse } from 'next/server';
import { nanoid } from 'nanoid';
import { desc } from 'drizzle-orm';
import { db, registryApps } from '@/src/db';
import { requireAdmin, generateKeypair, isValidPublicKey, emitAttestation, isAppAudienceSlug } from '@imajin/auth';
import { didFromPublicKey } from '@/src/lib/auth/crypto';
import { validateAppDeclarations } from '@/src/lib/kernel/app-declarations';
import { validateEmittableEvents } from '@/src/lib/kernel/emittable-events';
import { REGISTRY_APP_TIERS, type RegistryAppTier } from '@/src/db/schemas/registry';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

function isRegistryAppTier(value: unknown): value is RegistryAppTier {
  return typeof value === 'string' && (REGISTRY_APP_TIERS as readonly string[]).includes(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** Same shape `apps.provision` accepts for a slug. */
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,38}$/;

/** Postgres unique_violation — `registry.apps.slug` is unique (uniq_registry_apps_slug). */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === '23505';
}

/** A non-empty string (optionally trimmed), else `null` — the row's nullable text columns. */
function textOrNull(value: unknown, trim = false): string | null {
  if (typeof value !== 'string') return null;
  return (trim ? value.trim() : value) || null;
}

/** A valid slug, `null` when none was supplied, or `false` when it is malformed. */
function parseSlug(value: unknown): string | null | false {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' && SLUG_PATTERN.test(value) ? value : false;
}

type RegisterBody = {
  name?: string;
  description?: string;
  ownerDid?: string;
  callbackUrl?: string;
  homepageUrl?: string;
  logoUrl?: string;
  requestedScopes?: string[];
  providesScopes?: string[];
  dependsOn?: Array<{ aud: string; scopes: string[] }>;
  /** Registered slug (#2674) — reserves the `<slug>:*` scope namespace; required to declare `providesScopes`. */
  slug?: string;
  /** Operator-approved list of event types the app may emit via POST /api/events (#2638/#2641). Default: none. */
  emittableEvents?: string[];
  publicKey?: string;
  tier?: string;
  allowedRedirectHosts?: string[];
  tokenAudiences?: string[];
};

/** Required-field + tier validation, extracted to keep POST's own cognitive complexity down. */
function validateRegisterBody(
  body: RegisterBody,
): { error: string } | { ok: { tier: RegistryAppTier; name: string; callbackUrl: string; ownerDid: string; slug: string | null } } {
  if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
    return { error: 'name is required' };
  }
  if (!body.callbackUrl || typeof body.callbackUrl !== 'string') {
    return { error: 'callbackUrl is required' };
  }
  if (!body.ownerDid || typeof body.ownerDid !== 'string') {
    return { error: 'ownerDid is required' };
  }
  if (body.tier !== undefined && !isRegistryAppTier(body.tier)) {
    return { error: `tier must be one of: ${REGISTRY_APP_TIERS.join(', ')}` };
  }
  // #2674: an app's scope namespace is reserved by its registered slug, so an app
  // only declares `providesScopes` once it has one.
  const slug = parseSlug(body.slug);
  if (slug === false) {
    return { error: 'slug must be a lowercase, hyphenated identifier (e.g. \'dykil\')' };
  }
  return {
    ok: {
      tier: isRegistryAppTier(body.tier) ? body.tier : 'third_party',
      name: body.name,
      callbackUrl: body.callbackUrl,
      ownerDid: body.ownerDid,
      slug,
    },
  };
}

/** Resolve the app's keypair: developer-supplied (validated) or server-generated. */
function resolvePublicKey(suppliedPublicKey: unknown): { error: string } | { ok: { publicKey: string; keypairResponse?: { privateKey: string; publicKey: string } } } {
  if (typeof suppliedPublicKey === 'string' && suppliedPublicKey.trim()) {
    if (!isValidPublicKey(suppliedPublicKey)) {
      return { error: 'Invalid Ed25519 public key' };
    }
    return { ok: { publicKey: suppliedPublicKey.trim() } };
  }
  const generated = generateKeypair();
  return { ok: { publicKey: generated.publicKey, keypairResponse: generated } };
}

/** Explicit hosts win; otherwise derive a single host from callbackUrl's own origin. */
function resolveAllowedRedirectHosts(requested: unknown, callbackUrl: string): { error: string } | { ok: string[] } {
  const explicit = asStringArray(requested);
  if (explicit.length > 0) return { ok: explicit };
  try {
    return { ok: [new URL(callbackUrl).origin] };
  } catch {
    return { error: 'callbackUrl must be an absolute URL' };
  }
}

/** Insert the row; a taken `slug` (the unique index) is a conflict, not a 500. */
async function insertRegistryApp(
  values: typeof registryApps.$inferInsert,
): Promise<{ app: typeof registryApps.$inferSelect } | { conflict: true }> {
  try {
    const [app] = await db.insert(registryApps).values(values).returning();
    return { app };
  } catch (err) {
    if (values.slug && isUniqueViolation(err)) return { conflict: true };
    throw err;
  }
}

// GET /api/admin/registry/apps — list every app, including revoked (admin-scoped).
export async function GET(_request: NextRequest) {
  const session = await requireAdmin();
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const apps = await db
    .select({
      id: registryApps.id,
      ownerDid: registryApps.ownerDid,
      name: registryApps.name,
      description: registryApps.description,
      appDid: registryApps.appDid,
      callbackUrl: registryApps.callbackUrl,
      requestedScopes: registryApps.requestedScopes,
      providesScopes: registryApps.providesScopes,
      dependsOn: registryApps.dependsOn,
      emittableEvents: registryApps.emittableEvents,
      actAsAllowed: registryApps.actAsAllowed,
      status: registryApps.status,
      tier: registryApps.tier,
      allowedRedirectHosts: registryApps.allowedRedirectHosts,
      tokenAudiences: registryApps.tokenAudiences,
      revokedAt: registryApps.revokedAt,
      createdAt: registryApps.createdAt,
      updatedAt: registryApps.updatedAt,
    })
    .from(registryApps)
    .orderBy(desc(registryApps.createdAt));

  return NextResponse.json({ apps });
}

// POST /api/admin/registry/apps — register an app with full registry fields (admin-scoped).
export async function POST(request: NextRequest) {
  const session = await requireAdmin();
  if (!session?.actingAs) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let rawBody: Record<string, unknown>;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const body = rawBody as RegisterBody;

  const validated = validateRegisterBody(body);
  if ('error' in validated) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }
  const { tier, name, callbackUrl, ownerDid, slug } = validated.ok;

  const keyResult = resolvePublicKey(body.publicKey);
  if ('error' in keyResult) {
    return NextResponse.json({ error: keyResult.error }, { status: 400 });
  }
  const { publicKey, keypairResponse } = keyResult.ok;

  const appDid = didFromPublicKey(publicKey);

  // #1990: no ad-hoc scope strings — clamp to the declarative SCOPE_VOCABULARY (#1253).
  // #2663: widened by the app's own `providesScopes`; `dependsOn` audiences must be registered apps.
  // #2674: `providesScopes` must sit in the app's slug namespace, so they need a `slug`.
  const declarations = await validateAppDeclarations({
    providesScopes: body.providesScopes,
    dependsOn: body.dependsOn,
    requestedScopes: asStringArray(body.requestedScopes),
    slug,
  });
  if ('error' in declarations) {
    return NextResponse.json({ error: declarations.error }, { status: 400 });
  }
  const { requestedScopes: scopes, providesScopes, dependsOn } = declarations.ok;

  // #2638/#2641: the operator approves which event types this app may emit — default none.
  const emittable = validateEmittableEvents(body.emittableEvents);
  if ('error' in emittable) {
    return NextResponse.json({ error: emittable.error }, { status: 400 });
  }
  const emittableEvents = emittable.ok;

  const hostsResult = resolveAllowedRedirectHosts(body.allowedRedirectHosts, callbackUrl);
  if ('error' in hostsResult) {
    return NextResponse.json({ error: hostsResult.error }, { status: 400 });
  }
  const allowedRedirectHosts = hostsResult.ok;
  const tokenAudiences = asStringArray(body.tokenAudiences);
  // #2706: audiences are registry slugs. A host (every path-routed app shares one)
  // would make apps accept each other's tokens and can never be minted per app.
  const hostAudiences = tokenAudiences.filter((aud) => !isAppAudienceSlug(aud));
  if (hostAudiences.length > 0) {
    return NextResponse.json(
      { error: `tokenAudiences must be app slugs, not hosts or URLs: ${hostAudiences.join(', ')}` },
      { status: 400 },
    );
  }

  const { description, homepageUrl, logoUrl } = body;
  const id = `app_${nanoid(16)}`;

  const inserted = await insertRegistryApp({
    id,
    ownerDid,
    name: name.trim(),
    description: textOrNull(description, true),
    appDid,
    publicKey,
    callbackUrl,
    homepageUrl: textOrNull(homepageUrl),
    logoUrl: textOrNull(logoUrl),
    requestedScopes: scopes,
    providesScopes,
    dependsOn,
    emittableEvents,
    tier,
    slug,
    allowedRedirectHosts,
    tokenAudiences,
    // #1348: the admin surface only takes a single callbackUrl, so the
    // registered redirect_uris set is that one URI — keeps /oauth/authorize's
    // exact-set match behaving identically to the pre-#1348 comparison for
    // admin-registered apps.
    redirectUris: [callbackUrl],
  });
  if ('conflict' in inserted) {
    return NextResponse.json({ error: `slug '${slug}' is already registered` }, { status: 409 });
  }
  const { app } = inserted;

  emitAttestation({
    issuer_did: session.actingAs,
    subject_did: appDid,
    type: 'registry.app.registered',
    context_id: id,
    context_type: 'registry_app',
    payload: { appId: id, name: app.name, tier, ownerDid, slug, scopes, providesScopes, dependsOn, emittableEvents, allowedRedirectHosts, tokenAudiences },
  }).catch((err: unknown) => log.error({ err: String(err), appId: id }, 'registry.app.registered attestation failed'));

  const response: Record<string, unknown> = { ...app };
  if (keypairResponse) {
    response.keypair = keypairResponse;
  }

  return NextResponse.json(response, { status: 201 });
}
