import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { requireAuth, requireAppAuth } from '@imajin/auth';
import { corsHeaders } from '@imajin/config';

const log = createLogger('events');
import { isEventOrganizer } from '@/src/lib/organizer';
import { getClient } from '@imajin/db';

const sql = getClient();

const AUTH_SERVICE_URL = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';

async function resolveProfile(did: string): Promise<{ did: string; name: string | null; handle: string | null; avatar: string | null; email: string | null }> {
  try {
    const res = await fetch(`${AUTH_SERVICE_URL}/api/lookup/${encodeURIComponent(did)}`, { cache: 'no-store' });
    if (res.ok) {
      const data = await res.json();
      const identity = data.identity || data;
      return {
        did,
        name: identity.name || null,
        handle: identity.handle || null,
        avatar: identity.avatar || identity.avatarUrl || null,
        email: identity.email || null,
      };
    }
  } catch {}
  return { did, name: null, handle: null, avatar: null, email: null };
}

/**
 * GET /api/events/[id]/guests — list all tickets with profile info (owner or cohost)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const cors = corsHeaders(request);
  let did: string;

  // App auth path
  if (request.headers.get('x-app-did')) {
    const appResult = await requireAppAuth(request, { scope: 'events:read' });
    if ('error' in appResult) {
      return NextResponse.json({ error: appResult.error }, { status: appResult.status, headers: cors });
    }
    did = appResult.appAuth.userDid;
  } else {
    const authResult = await requireAuth(request);
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status });
    }
    const { identity } = authResult;
    did = identity.actingAs || identity.id;
  }

  const { id } = await params;

  try {
    const orgCheck = await isEventOrganizer(id, did);
    if (!orgCheck.authorized) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    const isOwner = orgCheck.role === 'creator' || orgCheck.role === 'cohost';

    const ticketRows = await sql`
      SELECT t.id, t.status, t.owner_did, t.price_paid, t.currency, t.purchased_at, t.used_at,
             t.payment_method, t.payment_id, t.hold_expires_at, t.registration_status,
             t.last_email_sent_at,
             tt.name as ticket_type,
             COALESCE(sr.answers->>'full_name', sr.answers->>'name') as attendee_name,
             o.fair_settlement, o.amount_total,
             i.contact_email,
             cred.value as fallback_email
      FROM events.tickets t
      JOIN events.ticket_types tt ON t.ticket_type_id = tt.id
      LEFT JOIN LATERAL (
        SELECT answers FROM dykil.survey_responses
        WHERE ticket_id = t.id
        ORDER BY created_at DESC LIMIT 1
      ) sr ON true
      LEFT JOIN events.orders o ON t.order_id = o.id
      LEFT JOIN auth.identities i ON i.id = t.owner_did
      LEFT JOIN LATERAL (
        SELECT value FROM auth.credentials
        WHERE did = t.owner_did AND type = 'email'
        ORDER BY created_at DESC LIMIT 1
      ) cred ON true
      WHERE t.event_id = ${id}
      ORDER BY t.created_at DESC
    `;

    // Batch-resolve unique DIDs
    const uniqueDids = [...new Set(ticketRows.map((t: any) => t.owner_did).filter(Boolean))] as string[];
    const profileMap = new Map<string, { name: string | null; handle: string | null; avatar: string | null; email: string | null }>();

    await Promise.all(
      uniqueDids.map(async (did) => {
        const profile = await resolveProfile(did);
        profileMap.set(did, { name: profile.name, handle: profile.handle, avatar: profile.avatar, email: profile.email });
      })
    );

    const guests = ticketRows.map((t: any) => {
      const profile = t.owner_did ? profileMap.get(t.owner_did) ?? null : null;
      const sqlEmail = t.contact_email || t.fallback_email || null;
      return {
        id: t.id,
        status: t.status,
        ownerDid: t.owner_did,
        pricePaid: t.price_paid,
        currency: t.currency,
        purchasedAt: t.purchased_at,
        usedAt: t.used_at,
        ticketType: t.ticket_type,
        paymentMethod: t.payment_method ?? null,
        paymentId: t.payment_id ?? null,
        holdExpiresAt: t.hold_expires_at ?? null,
        profile: (() => {
          if (profile) return { ...profile, email: sqlEmail || profile.email || null };
          if (sqlEmail) return { name: null, handle: null, avatar: null, email: sqlEmail };
          return null;
        })(),
        registrationStatus: t.registration_status ?? null,
        attendeeName: t.attendee_name ?? null,
        lastEmailSentAt: t.last_email_sent_at ?? null,
        fairSettlement: t.fair_settlement ?? null,
        orderAmountTotal: t.amount_total ?? null,
      };
    });

    return NextResponse.json({ guests, isOwner });
  } catch (error) {
    log.error({ err: String(error) }, 'Failed to fetch guests');
    return NextResponse.json({ error: 'Failed to fetch guests' }, { status: 500 });
  }
}
