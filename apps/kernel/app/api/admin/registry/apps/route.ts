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
import { requireAdmin, generateKeypair, isValidPublicKey, validateScopes, emitAttestation } from '@imajin/auth';
import { didFromPublicKey } from '@/src/lib/auth/crypto';
import { REGISTRY_APP_TIERS, type RegistryAppTier } from '@/src/db/schemas/registry';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

function isRegistryAppTier(value: unknown): value is RegistryAppTier {
  return typeof value === 'string' && (REGISTRY_APP_TIERS as readonly string[]).includes(value);
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

type RegisterBody = {
  name?: string;
  description?: string;
  ownerDid?: string;
  callbackUrl?: string;
  homepageUrl?: string;
  logoUrl?: string;
  requestedScopes?: string[];
  publicKey?: string;
  tier?: string;
  allowedRedirectHosts?: string[];
  tokenAudiences?: string[];
};

/** Required-field + tier validation, extracted to keep POST's own cognitive complexity down. */
function validateRegisterBody(
  body: RegisterBody,
): { error: string } | { ok: { tier: RegistryAppTier; name: string; callbackUrl: string; ownerDid: string } } {
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
  return {
    ok: {
      tier: isRegistryAppTier(body.tier) ? body.tier : 'third_party',
      name: body.name,
      callbackUrl: body.callbackUrl,
      ownerDid: body.ownerDid,
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
  const { tier, name, callbackUrl, ownerDid } = validated.ok;

  const keyResult = resolvePublicKey(body.publicKey);
  if ('error' in keyResult) {
    return NextResponse.json({ error: keyResult.error }, { status: 400 });
  }
  const { publicKey, keypairResponse } = keyResult.ok;

  const appDid = didFromPublicKey(publicKey);

  // #1990: no ad-hoc scope strings — clamp to the declarative SCOPE_VOCABULARY (#1253).
  const { valid: scopes } = validateScopes(asStringArray(body.requestedScopes));

  const hostsResult = resolveAllowedRedirectHosts(body.allowedRedirectHosts, callbackUrl);
  if ('error' in hostsResult) {
    return NextResponse.json({ error: hostsResult.error }, { status: 400 });
  }
  const allowedRedirectHosts = hostsResult.ok;
  const tokenAudiences = asStringArray(body.tokenAudiences);

  const { description, homepageUrl, logoUrl } = body;
  const id = `app_${nanoid(16)}`;

  const [app] = await db
    .insert(registryApps)
    .values({
      id,
      ownerDid,
      name: name.trim(),
      description: typeof description === 'string' ? description.trim() || null : null,
      appDid,
      publicKey,
      callbackUrl,
      homepageUrl: typeof homepageUrl === 'string' ? homepageUrl || null : null,
      logoUrl: typeof logoUrl === 'string' ? logoUrl || null : null,
      requestedScopes: scopes,
      tier,
      allowedRedirectHosts,
      tokenAudiences,
    })
    .returning();

  emitAttestation({
    issuer_did: session.actingAs,
    subject_did: appDid,
    type: 'registry.app.registered',
    context_id: id,
    context_type: 'registry_app',
    payload: { appId: id, name: app.name, tier, ownerDid, scopes, allowedRedirectHosts, tokenAudiences },
  }).catch((err: unknown) => log.error({ err: String(err), appId: id }, 'registry.app.registered attestation failed'));

  const response: Record<string, unknown> = { ...app };
  if (keypairResponse) {
    response.keypair = keypairResponse;
  }

  return NextResponse.json(response, { status: 201 });
}
