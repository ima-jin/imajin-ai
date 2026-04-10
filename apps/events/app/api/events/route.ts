import { NextRequest, NextResponse } from 'next/server';
import { db, events, ticketTypes } from '@/src/db';
import { requireHardDID, emitAttestation } from '@imajin/auth';
import { getClient } from '@imajin/db';
import { buildFairManifest } from '@imajin/fair';
import { and, asc, desc, eq, gt } from 'drizzle-orm';
import { randomBytes } from 'crypto';

const AUTH_URL = process.env.AUTH_SERVICE_URL!;

/**
 * POST /api/events - Create a new event
 * Requires hard DID (keypair-based identity)
 */
export async function POST(request: NextRequest) {
  // Require hard DID authentication
  const authResult = await requireHardDID(request);
  if ('error' in authResult) {
    return NextResponse.json({ error: authResult.error }, { status: authResult.status });
  }

  const { identity } = authResult;
  const did = identity.actingAs || identity.id;

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
    } = body;

    // Validate required fields
    if (!title) {
      return NextResponse.json({ error: 'title is required' }, { status: 400 });
    }
    if (!startsAt) {
      return NextResponse.json({ error: 'startsAt is required' }, { status: 400 });
    }

    // Generate event ID and DID
    const eventId = `evt_${randomBytes(12).toString('hex')}`;
    
    // Register event DID with auth service
    const eventKeypair = await generateEventKeypair();

    // Sign the registration payload
    const ed = await import('@noble/ed25519');
    const { sha512 } = await import('@noble/hashes/sha2.js');
    ed.hashes.sha512 = sha512;
    const regPayload = JSON.stringify({ publicKey: eventKeypair.publicKey, name: title, type: 'event' });
    const msgBytes = new TextEncoder().encode(regPayload);
    const privBytes = hexToBytes(eventKeypair.privateKey);
    const sigBytes = await ed.signAsync(msgBytes, privBytes);
    const signature = bytesToHex(sigBytes);

    const regRes = await fetch(`${AUTH_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: eventKeypair.publicKey,
        type: 'event',
        name: title,
        signature,
      }),
    });
    
    if (!regRes.ok) {
      const err = await regRes.json();
      return NextResponse.json({ error: `Failed to register event DID: ${err.error}` }, { status: 500 });
    }

    const regData = await regRes.json();
    const eventDid = regData.did;

    // Load node config and optional scope config for fair manifest
    const sql = getClient();
    const [relayRow] = await sql`
      SELECT node_fee_bps, buyer_credit_bps, node_operator_did
      FROM relay.relay_config
      WHERE id = 'singleton'
      LIMIT 1
    `;
    const scopeDid = identity.actingAs || null;
    let scopeFeeBps: number | null = null;
    if (scopeDid) {
      const [forestRow] = await sql`
        SELECT scope_fee_bps
        FROM profile.forest_config
        WHERE group_did = ${scopeDid}
        LIMIT 1
      `;
      scopeFeeBps = forestRow?.scope_fee_bps ?? null;
    }

    // Auto-generate .fair attribution manifest
    const fairManifest = buildFairManifest({
      creatorDid: did,
      contentDid: eventDid,
      contentType: 'event',
      scopeDid,
      scopeFeeBps,
      nodeFeeBps: relayRow?.node_fee_bps ?? undefined,
      buyerCreditBps: relayRow?.buyer_credit_bps ?? undefined,
      nodeOperatorDid: relayRow?.node_operator_did ?? undefined,
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
      status: 'draft',
      metadata: { fair: fairManifest },
    }).returning();

    // Fire and forget — never block the response
    emitAttestation({
      issuer_did: identity.id,
      subject_did: identity.id,
      type: 'event.created',
      context_id: event.id,
      context_type: 'event',
      payload: { eventDid: event.did, title },
    }).catch((err) => console.error('Attestation emit error:', err));

    // Create ticket types if provided
    const createdTicketTypes = [];
    if (ticketTypesInput && Array.isArray(ticketTypesInput)) {
      for (const tt of ticketTypesInput) {
        const ttId = `tkt_type_${randomBytes(8).toString('hex')}`;
        const [ticketType] = await db.insert(ticketTypes).values({
          id: ttId,
          eventId: event.id,
          name: tt.name,
          description: tt.description,
          price: tt.price,
          currency: tt.currency || 'USD',
          quantity: tt.quantity,
          perks: tt.perks || [],
        }).returning();
        createdTicketTypes.push(ticketType);
      }
    }

    // Create event chat conversation and add creator as admin
    const CHAT_URL = process.env.CHAT_SERVICE_URL || process.env.CHAT_URL;
    if (CHAT_URL) {
      try {
        await fetch(`${CHAT_URL}/api/d/${encodeURIComponent(eventDid)}/members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberDid: did, role: 'admin' }),
        });
        // Update conversation name (the POST creates with empty name)
        const { getClient: getChatClient } = await import('@imajin/db');
        const chatSql = getChatClient();
        await chatSql`
          UPDATE chat.conversations_v2 
          SET name = ${title}, created_by = ${identity.id}
          WHERE did = ${eventDid}
        `;
        console.log(`Created event chat ${eventDid} with creator ${identity.id} as admin`);
      } catch (chatError) {
        console.warn('Event chat creation failed (non-fatal):', chatError);
      }
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
    console.error('Failed to create event:', error);
    return NextResponse.json({ error: 'Failed to create event' }, { status: 500 });
  }
}

/**
 * GET /api/events - List events
 * Supports: ?courseSlug=intro-to-ai&upcoming=true&status=published&limit=20
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'published';
  const limit = parseInt(searchParams.get('limit') || '20');
  const courseSlug = searchParams.get('courseSlug');
  const upcoming = searchParams.get('upcoming') === 'true';

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
    console.error('Failed to list events:', error);
    return NextResponse.json({ error: 'Failed to list events' }, { status: 500 });
  }
}

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
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}
