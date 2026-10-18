import { requireAuth } from '@imajin/auth';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db, identities, identityMembers, registryApps } from '@/src/db';
import { DEFAULT_SENDERS, MAIL_PURPOSES } from '@/src/lib/mail/types';
import { listSenderConfigs, saveSenderConfig } from '@/src/lib/mail/store';
import { isDomainMailReady } from '@/src/lib/mail/readiness';
import { validateSenderConfig } from '@/src/lib/mail/validation';

export const dynamic = 'force-dynamic';

const senderInput = z.object({
  purpose: z.enum(MAIL_PURPOSES),
  appDid: z.string().max(256).optional(),
  domain: z.string().trim().max(253),
  localPart: z.string().max(64),
  displayName: z.string().max(100),
  replyTo: z.string().max(254).nullable().optional(),
}).strict();

type Context = { params: Promise<{ ownerDid: string }> };
function parseConfig(ownerDid: string, input: unknown) {
  const parsed = senderInput.safeParse(input);
  if (!parsed.success) return null;
  try {
    return validateSenderConfig({
      ...parsed.data, ownerDid, appDid: parsed.data.appDid ?? '', replyTo: parsed.data.replyTo ?? null,
    });
  } catch {
    return null;
  }
}

async function authorize(request: NextRequest, ownerDid: string) {
  const auth = await requireAuth(request, { sessionOnly: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const [membership] = await db.select({ role: identityMembers.role })
    .from(identityMembers)
    .innerJoin(identities, eq(identities.id, identityMembers.identityDid))
    .where(and(
      eq(identityMembers.identityDid, ownerDid),
      eq(identityMembers.memberDid, auth.identity.id),
      isNull(identityMembers.removedAt),
      inArray(identityMembers.role, ['owner', 'admin']),
      inArray(identities.scope, ['business', 'community', 'family']),
    )).limit(1);
  if (!membership) return NextResponse.json({ error: 'Organization owner or admin required' }, { status: 403 });
  return null;
}

function unavailable() {
  return NextResponse.json({ error: 'Mail sender settings unavailable' }, { status: 500 });
}

export async function GET(request: NextRequest, context: Context) {
  try {
    const { ownerDid } = await context.params;
    const denied = await authorize(request, ownerDid);
    if (denied) return denied;
    const senders = await listSenderConfigs(ownerDid);
    const domains = [...new Set(senders.map(sender => sender.domain))];
    const readiness = Object.fromEntries(await Promise.all(
      domains.map(async value => [value, await isDomainMailReady(ownerDid, value)]),
    ));
    return NextResponse.json({ senders, defaults: DEFAULT_SENDERS, readiness }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch {
    return unavailable();
  }
}

export async function PUT(request: NextRequest, context: Context) {
  try {
    const { ownerDid } = await context.params;
    const denied = await authorize(request, ownerDid);
    if (denied) return denied;
    const config = parseConfig(ownerDid, await request.json().catch(() => null));
    if (!config) return NextResponse.json({ error: 'Invalid sender settings' }, { status: 400 });
    if (config.appDid) {
      const [app] = await db.select({ id: registryApps.id }).from(registryApps)
        .where(and(
          eq(registryApps.appDid, config.appDid),
          eq(registryApps.ownerDid, ownerDid),
          eq(registryApps.status, 'active'),
          isNull(registryApps.revokedAt),
        )).limit(1);
      if (!app) return NextResponse.json({ error: 'App must belong to this organization and be active' }, { status: 403 });
    }
    await saveSenderConfig(config);
    return NextResponse.json({ ok: true });
  } catch {
    return unavailable();
  }
}
