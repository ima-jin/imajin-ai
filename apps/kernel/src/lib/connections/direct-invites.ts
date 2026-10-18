import { randomBytes } from 'node:crypto';
import { NextResponse } from 'next/server';
import { and, eq, isNull, ne, or, sql, desc } from 'drizzle-orm';
import { requireAuth, resolveEffectiveDid } from '@imajin/auth';
import { createLogger } from '@imajin/logger';
import { rateLimit } from '@imajin/config';
import { db, identities, invites, connections, pods, podMembers, attestations, notifications, preferences } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { generateId } from '@/src/lib/kernel/id';
import { buildNotificationFrame, pushNotificationToDid } from '@/src/lib/notify/ws-push';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Invite = typeof invites.$inferSelect;
type Actor = { did: string; actorDid: string; composedBy: string | null };
const log = createLogger('kernel');

class DirectInviteError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Keep direct request failures separate from the unchanged email/link flows. */
export async function directInviteResponse(operation: () => Promise<NextResponse>) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DirectInviteError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    log.error({ err: String(error) }, 'Direct connection request failed');
    return NextResponse.json({ error: 'Connection request could not be saved' }, { status: 503 });
  }
}

async function resolveActor(request: Request): Promise<Actor> {
  const auth = await resolveEffectiveDid(request, { scope: 'connections:write' });
  if (!auth.ok) throw new DirectInviteError(auth.error, auth.status);
  // EffectiveDid deliberately omits the human behind act-as; retain that
  // authenticated actor separately in the node-witnessed signed evidence.
  const session = auth.via === 'session' ? await requireAuth(request) : null;
  if (session && 'error' in session) throw new DirectInviteError('Unauthorized', 401);
  return {
    did: auth.effectiveDid,
    actorDid: session && 'identity' in session ? session.identity.id : auth.effectiveDid,
    composedBy: auth.composedBy,
  };
}

/** Ordered identity locks serialize both directions of a pair, including reconnect. */
async function lockPair(tx: Transaction, fromDid: string, toDid: string, requireAvailable = true) {
  const pair = [fromDid, toDid].sort((a, b) => a.localeCompare(b));
  for (const did of pair) {
    const [identity] = await tx.select().from(identities).where(eq(identities.id, did)).for('update');
    if (requireAvailable && (!identity || identity.tier === 'soft' || identity.suspendedAt)) {
      throw new DirectInviteError('Identity is unavailable', 404);
    }
  }
  return pair;
}

function pairWhere(didA: string, didB: string) {
  return and(eq(connections.didA, didA), eq(connections.didB, didB));
}

async function assertNotConnected(tx: Transaction, didA: string, didB: string) {
  const [connection] = await tx.select().from(connections)
    .where(and(pairWhere(didA, didB), isNull(connections.disconnectedAt))).limit(1);
  if (connection) throw new DirectInviteError('Already connected', 409);
}

export function publicDirectInvite(invite: Invite) {
  // Explicit allowlist: never disclose email/phone or onboarding/payment context.
  return {
    id: invite.id, code: invite.code, fromDid: invite.fromDid, fromHandle: invite.fromHandle,
    toDid: invite.toDid, note: invite.note, delivery: invite.delivery, status: invite.status,
    maxUses: invite.maxUses, usedCount: invite.usedCount, createdAt: invite.createdAt,
    acceptedAt: invite.acceptedAt, expiresAt: invite.expiresAt,
  };
}

async function signedEvent(tx: Transaction, invite: Invite, actor: Actor, type: 'connection.invited' | 'connection.accepted') {
  const row = await prepareMechanicalAttestation({
    subjectDid: type === 'connection.invited' ? invite.toDid! : invite.fromDid,
    type, contextId: invite.id, contextType: 'connection',
    payload: {
      fromDid: invite.fromDid, toDid: invite.toDid, actorDid: actor.actorDid,
      composedBy: actor.composedBy, effectiveDid: actor.did,
      invite_code: invite.code, delivery: 'direct',
    },
  });
  await tx.insert(attestations).values(row);
}

/** Persist the in-app notification with the request; push only after commit. */
async function requestNotification(tx: Transaction, invite: Invite, name: string) {
  const [pref] = await tx.select().from(preferences).where(and(
    eq(preferences.did, invite.toDid!), eq(preferences.scope, 'connection.invited'),
  )).limit(1);
  const row = {
    id: generateId('ntf_'), recipientDid: invite.toDid!, scope: 'connection.invited',
    urgency: 'normal', title: `${name} sent you a connection request`,
    body: 'Open Connections to accept or decline.', data: { code: invite.code, fromDid: invite.fromDid, url: '/connections' },
    channelsSent: pref?.inapp === false ? [] : ['inapp'], read: false, createdAt: new Date(),
  };
  await tx.insert(notifications).values(row);
  return pref?.inapp === false ? null : row;
}

export async function createDirectInvite(request: Request, body: Record<string, unknown>) {
  const actor = await resolveActor(request);
  const throttled = directRequestRateLimit(actor);
  if (throttled) return throttled;
  const hasDid = Object.hasOwn(body, 'toDid');
  const hasHandle = Object.hasOwn(body, 'handle');
  if (hasDid === hasHandle || body.toEmail || (body.delivery && body.delivery !== 'direct')) {
    throw new DirectInviteError('Supply exactly one of toDid or handle', 400);
  }
  const target = hasDid ? body.toDid : body.handle;
  if (typeof target !== 'string' || !target.trim()) throw new DirectInviteError('Invalid target', 400);
  const value = target.trim();
  if (hasDid && !value.startsWith('did:')) throw new DirectInviteError('Invalid DID', 400);
  const [recipient] = await db.select({ did: identities.id, handle: identities.handle, name: identities.name })
    .from(identities).where(and(
      hasDid ? eq(identities.id, value) : sql`lower(${identities.handle}) = ${value.replace(/^@/, '').toLowerCase()}`,
      ne(identities.tier, 'soft'), isNull(identities.suspendedAt),
    )).limit(1);
  if (!recipient) throw new DirectInviteError('Identity not found', 404);
  if (recipient.did === actor.did) throw new DirectInviteError('Cannot connect to yourself', 400);

  const result = await db.transaction(async (tx) => {
    const [didA, didB] = await lockPair(tx, actor.did, recipient.did);
    await assertNotConnected(tx, didA, didB);
    const [pending] = await tx.select().from(invites).where(and(
      eq(invites.delivery, 'direct'), eq(invites.status, 'pending'),
      or(
        and(eq(invites.fromDid, actor.did), eq(invites.toDid, recipient.did)),
        and(eq(invites.fromDid, recipient.did), eq(invites.toDid, actor.did)),
      ),
    )).limit(1);
    if (pending) throw new DirectInviteError('A connection request is already pending', 409);
    const [sender] = await tx.select({ handle: identities.handle, name: identities.name })
      .from(identities).where(eq(identities.id, actor.did)).limit(1);
    const [invite] = await tx.insert(invites).values({
      id: generateId('inv_'), code: randomBytes(12).toString('hex'),
      fromDid: actor.did, fromHandle: sender.handle, toDid: recipient.did,
      delivery: 'direct', status: 'pending', maxUses: 1,
      note: typeof body.note === 'string' ? body.note : null,
    }).returning();
    await signedEvent(tx, invite, actor, 'connection.invited');
    const notification = await requestNotification(tx, invite, sender.name || sender.handle || actor.did);
    return { invite, notification };
  });
  if (result.notification) {
    void pushNotificationToDid(recipient.did, buildNotificationFrame(result.notification))
      .catch((error: unknown) => log.error({ err: String(error) }, 'Direct request notification push failed'));
  }
  return NextResponse.json({
    invite: { ...publicDirectInvite(result.invite), toHandle: recipient.handle, toName: recipient.name },
  }, { status: 201 });
}

function directRequestRateLimit(actor: Actor) {
  for (const key of [`actor:${actor.actorDid}`, `effective:${actor.did}`]) {
    const result = rateLimit(`connections:direct:${key}`, 20, 60_000);
    if (result.limited) {
      return NextResponse.json({ error: 'Too many connection requests', retryAfter: result.retryAfter }, {
        status: 429, headers: { 'Retry-After': String(result.retryAfter) },
      });
    }
  }
  return null;
}

export async function listIncomingDirectInvites(did: string) {
  const rows = await db.select({
    invite: invites, fromHandle: identities.handle, fromName: identities.name,
  }).from(invites).leftJoin(identities, eq(identities.id, invites.fromDid))
    .where(and(eq(invites.toDid, did), eq(invites.delivery, 'direct'), eq(invites.status, 'pending')))
    .orderBy(desc(invites.createdAt));
  const [recipient] = await db.select({ handle: identities.handle }).from(identities).where(eq(identities.id, did)).limit(1);
  return NextResponse.json({ invites: rows.map((row) => ({
    ...publicDirectInvite(row.invite), fromHandle: row.fromHandle,
    fromName: row.fromName, toHandle: recipient?.handle ?? null,
  })) });
}

export async function transitionDirectInvite(request: Request, original: Invite, action: 'accept' | 'decline' | 'cancel') {
  const actor = await resolveActor(request);
  if (!original.toDid || original.toDid === original.fromDid) {
    throw new DirectInviteError('Invalid direct request', 400);
  }
  const result = await db.transaction(async (tx) => {
    const [didA, didB] = await lockPair(tx, original.fromDid, original.toDid!, action === 'accept');
    const [invite] = await tx.select().from(invites).where(eq(invites.code, original.code)).for('update');
    if (!invite || invite.delivery !== 'direct') throw new DirectInviteError('Invite not found', 404);
    const authorizedDid = action === 'cancel' ? invite.fromDid : invite.toDid;
    if (authorizedDid !== actor.did) throw new DirectInviteError('Not authorized', 403);
    if (invite.status !== 'pending' || invite.usedCount >= invite.maxUses) {
      throw new DirectInviteError(`Invite is ${invite.status}`, 410);
    }
    if (invite.expiresAt && new Date(invite.expiresAt) <= new Date()) {
      throw new DirectInviteError('Invite has expired', 410);
    }
    if (action !== 'accept') {
      await tx.update(invites).set({ status: action === 'decline' ? 'declined' : 'revoked' })
        .where(and(eq(invites.code, invite.code), eq(invites.status, 'pending')));
      return { ok: true };
    }
    await assertNotConnected(tx, didA, didB);
    const pod = { id: generateId('pod_'), name: `${invite.fromHandle || invite.fromDid} ↔ ${actor.did}` };
    await tx.insert(pods).values({ ...pod, ownerDid: invite.fromDid, type: 'personal', visibility: 'private' });
    await tx.insert(podMembers).values([
      { podId: pod.id, did: invite.fromDid, role: 'member', addedBy: invite.fromDid },
      { podId: pod.id, did: actor.did, role: 'member', addedBy: actor.did },
    ]);
    await tx.insert(connections).values({ didA, didB })
      .onConflictDoUpdate({ target: [connections.didA, connections.didB], set: { disconnectedAt: null } });
    await tx.update(invites).set({
      status: 'accepted', usedCount: 1, acceptedAt: new Date().toISOString(), consumedBy: actor.did,
    }).where(and(eq(invites.code, invite.code), eq(invites.status, 'pending')));
    await signedEvent(tx, invite, actor, 'connection.accepted');
    return { ok: true, pod };
  });
  return NextResponse.json(result, { status: action === 'accept' ? 201 : 200 });
}
