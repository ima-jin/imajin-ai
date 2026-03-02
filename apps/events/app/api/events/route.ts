import { NextRequest, NextResponse } from 'next/server';
import { db, events, ticketTypes } from '@/src/db';
import { requireHardDID } from '@/src/lib/auth';
import { desc, eq } from 'drizzle-orm';
import { randomBytes } from 'crypto';
import { createEventPod } from '@/src/lib/pods';

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

  try {
    const body = await request.json();
    const {
      title,
      description,
      startsAt,
      endsAt,
      isVirtual,
      virtualUrl,
      venue,
      address,
      city,
      country,
      imageUrl,
      tags,
      tickets: ticketTypesInput,
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
    const eventDid = `did:imajin:${eventKeypair.publicKey.slice(0, 16)}`;
    
    const regRes = await fetch(`${AUTH_URL}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publicKey: eventKeypair.publicKey,
        type: 'event',
        name: title,
      }),
    });
    
    if (!regRes.ok) {
      const err = await regRes.json();
      return NextResponse.json({ error: `Failed to register event DID: ${err.error}` }, { status: 500 });
    }

    // Create trust pod and group chat for the event
    const { podId, conversationId } = await createEventPod({
      eventId,
      eventDid,
      eventTitle: title,
      creatorDid: identity.id,
    });

    // Create event
    const [event] = await db.insert(events).values({
      id: eventId,
      did: eventDid,
      publicKey: eventKeypair.publicKey,
      privateKey: eventKeypair.privateKey,
      creatorDid: identity.id,
      title,
      description,
      startsAt: new Date(startsAt),
      endsAt: endsAt ? new Date(endsAt) : null,
      isVirtual: isVirtual || false,
      virtualUrl,
      venue,
      address,
      city,
      country,
      imageUrl,
      tags: tags || [],
      status: 'draft',
      podId,
    }).returning();

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

    // Store event keypair (in real system, this would be encrypted/secured)
    // For now, we return it so creator can sign tickets
    return NextResponse.json({
      event,
      ticketTypes: createdTicketTypes,
      podId,
      conversationId,
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
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status') || 'published';
  const limit = parseInt(searchParams.get('limit') || '20');

  try {
    const eventList = await db
      .select()
      .from(events)
      .where(eq(events.status, status))
      .orderBy(desc(events.startsAt))
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
