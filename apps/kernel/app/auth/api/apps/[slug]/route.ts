import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db, identities } from '@/src/db';
import { resolveAppDirectoryForIdentity } from '@/src/lib/kernel/app-nav';
import { authenticateAppDirectory } from '@/src/lib/kernel/app-directory-request';
import { canManageGroupApps, setGroupAppMembership, setPersonAppMembership } from '@/src/lib/kernel/app-membership';

type Context = { params: Promise<{ slug: string }> };

async function validateBodyTarget(request: NextRequest, did: string): Promise<NextResponse | null> {
  const text = await request.text();
  if (!text) return null;
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
    if (['for', 'target', 'did', 'targetDid'].some((key) => key in body && body[key] !== did)) {
      return NextResponse.json({ error: 'Forbidden - self only' }, { status: 403 });
    }
    return null;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
}
/** The direct link can reveal an unlisted app, but never a non-member's private app. */
export async function GET(request: NextRequest, context: Context) {
  const auth = await authenticateAppDirectory(request);
  if ('error' in auth) return auth.error;
  const { slug } = await context.params;
  const apps = await resolveAppDirectoryForIdentity(auth.did, { slug });
  if (apps.length === 0) return NextResponse.json({ error: 'App not found' }, { status: 404 });
  return NextResponse.json({ apps }, { headers: { 'Cache-Control': 'private, no-store' } });
}

async function mutate(request: NextRequest, context: Context, added: boolean) {
  const auth = await authenticateAppDirectory(request);
  if ('error' in auth) return auth.error;
  const bodyError = await validateBodyTarget(request, auth.did);
  if (bodyError) return bodyError;
  const [identity] = await db.select({ scope: identities.scope }).from(identities)
    .where(eq(identities.id, auth.did)).limit(1);
  if (!identity) return NextResponse.json({ error: 'Identity not found' }, { status: 404 });
  const person = identity.scope === 'actor';
  const permitted = person ? auth.did === auth.callerDid : await canManageGroupApps(auth.did, auth.callerDid);
  if (!permitted) return NextResponse.json({ error: 'Must be self or group owner/admin' }, { status: 403 });

  const { slug } = await context.params;
  const directory = await resolveAppDirectoryForIdentity(auth.did, { slug });
  const app = directory.find((row) => row.slug === slug);
  if (!app) return NextResponse.json({ error: 'App not found' }, { status: 404 });
  if (app.inherited) {
    return NextResponse.json({ error: 'This app follows identity membership; leave the owning identity to remove it.' }, { status: 409 });
  }
  if (added && !app.available) return NextResponse.json({ error: 'App unavailable for this identity scope' }, { status: 403 });
  if (person) await setPersonAppMembership(auth.did, slug, added);
  else await setGroupAppMembership(auth.did, slug, added);

  // Removing membership deliberately does not revoke a still-live authorization.
  const options = app.visibility === 'unlisted' ? { slug } : undefined;
  return NextResponse.json({ apps: await resolveAppDirectoryForIdentity(auth.did, options) }, {
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

export async function PUT(request: NextRequest, context: Context) {
  return mutate(request, context, true);
}

export async function DELETE(request: NextRequest, context: Context) {
  return mutate(request, context, false);
}
