import { NextResponse } from 'next/server';
import { withLogger, type Logger } from '@imajin/logger';
import { publish } from '@imajin/bus';
import { db, events, ticketTypes } from '@/src/db';
import { requireHardDID, requireAppAuth, resolveActingDid, type Identity } from '@imajin/auth';
import { corsHeaders, getNodeSelf } from '@imajin/config';
import { getClient } from '@imajin/db';
import { buildFairManifest } from '@imajin/fair';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';

const AUTH_URL = process.env.AUTH_SERVICE_URL!;

interface EventCreatorAuth {
  did: string;
  identity: Identity;
}

/** Authenticate the event creator via app-DID auth (if present) or hard-DID auth, otherwise return the error response. */
async function authenticateEventCreator(request: Request, cors: HeadersInit): Promise<EventCreatorAuth | NextResponse> {
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'events:write' });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
    const did = appResult.appAuth.userDid;
    return { did, identity: { id: did, scope: 'actor' } };
  }

  const authResult = await requireHardDID(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }
  return { did: resolveActingDid(authResult.identity), identity: authResult.identity };
}

interface CreateEventValidationFields {
  title?: unknown;
  startsAt?: unknown;
  eventType?: unknown;
  targetAmount?: unknown;
}

/** Validate the required fields of a create-event request body, returning the error response when invalid. */
function validateCreateEventBody(body: CreateEventValidationFields): NextResponse | null {
  if (!body.title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 });
  }
  if (!body.startsAt) {
    return NextResponse.json({ error: 'startsAt is required' }, { status: 400 });
  }
  if (body.eventType === 'campaign') {
    const { targetAmount } = body;
    if (typeof targetAmount !== 'number' || targetAmount <= 0 || !Number.isInteger(targetAmount)) {
      return NextResponse.json({ error: 'targetAmount must be a positive integer (cents)' }, { status: 400 });
    }
  }
  return null;
}

/** Register the event's DID with the auth service, signing the payload the same way /api/register verifies it. */
async function registerEventDid(title: string, eventKeypair: { publicKey: string; privateKey: string }): Promise<{ did: string } | NextResponse> {
  // Sign the registration payload — must match what /api/register verifies
  const ed = await import('@noble/ed25519');
  const { sha512 } = await import('@noble/hashes/sha2.js');
  ed.hashes.sha512 = sha512;
  const regPayload = JSON.stringify({ publicKey: eventKeypair.publicKey, name: title, scope: 'actor', subtype: 'event' });
  const msgBytes = new TextEncoder().encode(regPayload);
  const privBytes = hexToBytes(eventKeypair.privateKey);
  const sigBytes = await ed.signAsync(msgBytes, privBytes);
  const signature = bytesToHex(sigBytes);

  const regRes = await fetch(`${AUTH_URL}/api/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: eventKeypair.publicKey,
      scope: 'actor',
      subtype: 'event',
      name: title,
      signature,
    }),
  });

  if (!regRes.ok) {
    const err = await regRes.json();
    return NextResponse.json({ error: `Failed to register event DID: ${err.error}` }, { status: 500 });
  }

  const regData = await regRes.json();
  return { did: regData.did };
}

/** Look up the scope's fee-bps override (via forest_config), or null when there is no scope or override. */
async function resolveScopeFeeBps(scopeDid: string | null): Promise<number | null> {
  if (!scopeDid) return null;
  const sql = getClient();
  const [forestRow] = await sql`
    SELECT scope_fee_bps
    FROM profile.forest_config
    WHERE group_did = ${scopeDid}
    LIMIT 1
  `;
  return forestRow?.scope_fee_bps ?? null;
}

/** Insert the ticket types provided at event-creation time, returning the created rows. */
async function createTicketTypesForEvent(eventId: string, ticketTypesInput: unknown): Promise<Array<typeof ticketTypes.$inferSelect>> {
  const createdTicketTypes: Array<typeof ticketTypes.$inferSelect> = [];
  if (!Array.isArray(ticketTypesInput)) return createdTicketTypes;

  for (const tt of ticketTypesInput) {
    const ttId = `tkt_type_${randomBytes(8).toString('hex')}`;
    const [ticketType] = await db.insert(ticketTypes).values({
      id: ttId,
      eventId,
      name: tt.name,
      description: tt.description,
      price: tt.price,
      currency: tt.currency || 'USD',
      quantity: tt.quantity,
      perks: tt.perks || [],
    }).returning();
    createdTicketTypes.push(ticketType);
  }
  return createdTicketTypes;
}

/** Best-effort: create the event's chat conversation, add the creator as admin, and sync its name-display policy. */
async function createEventChat(params: {
  chatUrl: string;
  eventDid: string;
  creatorDid: string;
  creatorId: string;
  title: string;
  nameDisplayPolicy: string | undefined;
  log: Logger;
}): Promise<void> {
  const { chatUrl, eventDid, creatorDid, creatorId, title, nameDisplayPolicy, log } = params;

  try {
    await fetch(`${chatUrl}/api/d/${encodeURIComponent(eventDid)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ memberDid: creatorDid, role: 'admin' }),
    });
    // Update conversation name (the POST creates with empty name)
    const { getClient: getChatClient } = await import('@imajin/db');
    const chatSql = getChatClient();
    await chatSql`
      UPDATE chat.conversations_v2 
      SET name = ${title}, created_by = ${creatorId}
      WHERE did = ${eventDid}
    `;
    log.info({ eventDid, creatorId }, 'Created event chat with creator as admin');
  } catch (chatError) {
    log.warn({ err: String(chatError) }, 'Event chat creation failed (non-fatal)');
  }

  // Sync name display policy to chat conversation context
  try {
    const internalKey = process.env.AUTH_INTERNAL_API_KEY;
    await fetch(`${chatUrl}/api/d/${encodeURIComponent(eventDid)}/context`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(internalKey ? { 'Authorization': `Bearer ${internalKey}` } : {}),
      },
      body: JSON.stringify({ context: { nameDisplayPolicy: nameDisplayPolicy || 'attendee_choice' } }),
    });
  } catch {
    // Best-effort — chat conversation may not exist yet
  }
}

/**
 * POST /api/events - Create a new event
 * Requires hard DID (keypair-based identity)
 */
export const POST = withLogger('events', async (request, { log, correlationId }) => {
  const cors = corsHeaders(request);
  const auth = await authenticateEventCreator(request, cors);
  if (auth instanceof NextResponse) return auth;
  const { did, identity } = auth;

  try {
    const body = await request.json();
    const {
      title,
      description,
      startsAt,
      endsAt,
      locationType,
      isVirtual,
      virtualUrl,
      venue,
      address,
      city,
      country,
      imageUrl,
      imageAssetId,
      tags,
      tickets: ticketTypesInput,
      courseSlug,
      emtEmail,
      eventType,
      targetAmount,
      deadline,
      nameDisplayPolicy,
      chatEnabled,
    } = body;

    const validationError = validateCreateEventBody(body);
    if (validationError) return validationError;

    // Generate event ID and DID
    const eventId = `evt_${randomBytes(12).toString('hex')}`;

    // Register event DID with auth service
    const eventKeypair = await generateEventKeypair();
    const registration = await registerEventDid(title, eventKeypair);
    if (registration instanceof NextResponse) return registration;
    const { did: eventDid } = registration;

    // Load node config (via the registry, #2000) and optional scope config for fair manifest
    const nodeSelf = await getNodeSelf();
    const scopeDid = identity.actingAs || null;
    const scopeFeeBps = await resolveScopeFeeBps(scopeDid);

    // Auto-generate .fair attribution manifest
    const fairManifest = buildFairManifest({
      creatorDid: did,
      contentDid: eventDid,
      contentType: 'event',
      scopeDid,
      scopeFeeBps,
      nodeFeeBps: nodeSelf?.nodeFeeBps ?? undefined,
      buyerCreditBps: nodeSelf?.buyerCreditBps ?? undefined,
      nodeOperatorDid: nodeSelf?.nodeOperatorDid ?? undefined,
    });

    // Create event
    const [event] = await db.insert(events).values({
      id: eventId,
      did: eventDid,
      publicKey: eventKeypair.publicKey,
      privateKey: eventKeypair.privateKey,
      creatorDid: did,
      title,
      description,
      startsAt: new Date(startsAt),
      endsAt: endsAt ? new Date(endsAt) : null,
      timezone: body.timezone || null,
      locationType: locationType || (isVirtual ? 'virtual' : 'physical'),
      isVirtual: locationType ? locationType !== 'physical' : (isVirtual || false),
      virtualUrl,
      venue,
      address,
      city,
      country,
      imageUrl,
      imageAssetId: imageAssetId || null,
      tags: tags || [],
      courseSlug: courseSlug || null,
      emtEmail: emtEmail || null,
      nameDisplayPolicy: nameDisplayPolicy || 'attendee_choice',
      chatEnabled: chatEnabled === undefined  ? true : chatEnabled,
      eventType: eventType || 'event',
      targetAmount: eventType === 'campaign' ? targetAmount : null,
      deadline: eventType === 'campaign' && deadline ? new Date(deadline) : null,
      status: 'draft',
      metadata: { fair: fairManifest },
    }).returning();

    publish('event.create', {
      issuer: did,
      subject: did,
      scope: 'events',
      payload: { eventId: event.id, eventDid: event.did, title },
      correlationId,
    }).catch((err) => log.error({ err: String(err) }, 'Publish error'));

    // Fire and forget — never block the response
    publish('event.created', {
      issuer: identity.id,
      subject: identity.id,
      scope: 'events',
      payload: {
        eventDid: event.did,
        title,
        context_id: event.id,
        context_type: 'event',
      },
    }).catch((err) => log.error({ err: String(err) }, 'Publish error'));

    // Create ticket types if provided
    const createdTicketTypes = await createTicketTypesForEvent(event.id, ticketTypesInput);

    // Create event chat conversation and add creator as admin
    const CHAT_URL = process.env.CHAT_SERVICE_URL || process.env.CHAT_URL;
    if (CHAT_URL) {
      await createEventChat({
        chatUrl: CHAT_URL,
        eventDid,
        creatorDid: did,
        creatorId: identity.id,
        title,
        nameDisplayPolicy,
        log,
      });
    }

    // Store event keypair (in real system, this would be encrypted/secured)
    // For now, we return it so creator can sign tickets
    return NextResponse.json({
      event,
      ticketTypes: createdTicketTypes,
      // Include keypair for ticket signing (creator responsibility to secure)
      eventKeypair: {
        publicKey: eventKeypair.publicKey,
        privateKey: eventKeypair.privateKey, // ⚠️ Creator must secure this
      },
    }, { status: 201 });

  } catch (error) {
    log.error({ err: String(error) }, 'Failed to create event');
    return NextResponse.json({ error: 'Failed to create event' }, { status: 500 });
  }
});

/**
 * GET /api/events - List events
 * Supports: ?courseSlug=intro-to-ai&upcoming=true&status=published&limit=20
 */
/** Fields safe to return for events:read app scope */
function filterEventForApp(event: Record<string, any>): Record<string, any> {
  const { id, did, creatorDid, title, description, startsAt, endsAt, timezone, locationType, isVirtual, virtualUrl, venue, address, city, country, status, accessMode, imageUrl, imageAssetId, tags, courseSlug, nameDisplayPolicy, chatEnabled, createdAt, updatedAt } = event;
  return { id, did, creatorDid, title, description, startsAt, endsAt, timezone, locationType, isVirtual, virtualUrl, venue, address, city, country, status, accessMode, imageUrl, imageAssetId, tags, courseSlug, nameDisplayPolicy, chatEnabled, createdAt, updatedAt };
}

export const GET = withLogger('events', async (request, { log }) => {
  const cors = corsHeaders(request);
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'published';
  const limit = Number.parseInt(searchParams.get('limit') || '20');
  const courseSlug = searchParams.get('courseSlug');
  const upcoming = searchParams.get('upcoming') === 'true';

  // App auth path
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'events:read' });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
    try {
      const conditions = [eq(events.status, status)];
      if (courseSlug) conditions.push(eq(events.courseSlug, courseSlug));
      if (upcoming) conditions.push(gt(events.startsAt, new Date()));

      const eventList = await db
        .select()
        .from(events)
        .where(and(...conditions))
        .orderBy(upcoming ? asc(events.startsAt) : desc(events.startsAt))
        .limit(limit);

      return NextResponse.json({ events: eventList.map(e => filterEventForApp(e as Record<string, any>)) }, { headers: cors });
    } catch (error) {
      log.error({ err: String(error) }, 'Failed to list events (app auth)');
      return NextResponse.json({ error: 'Failed to list events' }, { status: 500, headers: cors });
    }
  }

  try {
    const conditions = [eq(events.status, status)];
    if (courseSlug) conditions.push(eq(events.courseSlug, courseSlug));
    if (upcoming) conditions.push(gt(events.startsAt, new Date()));

    const eventList = await db
      .select()
      .from(events)
      .where(and(...conditions))
      .orderBy(upcoming ? asc(events.startsAt) : desc(events.startsAt))
      .limit(limit);

    return NextResponse.json({ events: eventList });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to list events');
    return NextResponse.json({ error: 'Failed to list events' }, { status: 500 });
  }
});

// Helper to generate keypair for event
async function generateEventKeypair() {
  const ed = await import('@noble/ed25519');
  const { sha512 } = await import('@noble/hashes/sha2.js');
  ed.hashes.sha512 = sha512;
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKey(privateKey);
  return {
    privateKey: bytesToHex(privateKey),
    publicKey: bytesToHex(publicKey),
  };
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}
