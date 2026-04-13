// DEPRECATED: Use /api/onboard/verify instead. Kept for existing magic links in the wild.

/**
 * GET /api/magic?token=xxx
 *
 * Magic link authentication for ticket holders.
 * Verifies the token, creates/updates identity, sets session cookie, and redirects to event.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/src/db';
import { identities } from '@/src/db';
import { eq } from 'drizzle-orm';
import { createSessionToken, getSessionCookieOptions } from '@/src/lib/auth/jwt';
import { emitSessionAttestation } from '@/src/lib/auth/emit-session-attestation';
import { createLogger } from '@imajin/logger';

const log = createLogger('kernel');

const EVENTS_SERVICE_URL = process.env.EVENTS_SERVICE_URL || 'http://localhost:3006';
const EVENTS_URL = process.env.EVENTS_URL || 'https://events.imajin.ai';

interface TicketData {
  ticket: {
    id: string;
    eventId: string;
    ownerDid: string;
    status: string;
  };
  event: {
    id: string;
    title: string;
    startsAt: string;
  };
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const token = searchParams.get('token');

    if (!token) {
      return new NextResponse(
        `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Invalid Link</title>
          <style>
            body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
            h1 { color: #ef4444; }
          </style>
        </head>
        <body>
          <h1>Invalid Magic Link</h1>
          <p>This link is missing a token. Please use the link from your confirmation email.</p>
        </body>
        </html>
        `,
        {
          status: 400,
          headers: { 'Content-Type': 'text/html' },
        }
      );
    }

    // Verify token with events service
    const eventsResponse = await fetch(
      `${EVENTS_SERVICE_URL}/api/tickets/by-token/${token}`,
      {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
      }
    );

    if (!eventsResponse.ok) {
      const errorText = await eventsResponse.text();
      log.error({ status: eventsResponse.status, body: errorText }, 'Token verification failed');

      return new NextResponse(
        `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Invalid or Expired Token</title>
          <style>
            body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
            h1 { color: #ef4444; }
          </style>
        </head>
        <body>
          <h1>Invalid or Expired Link</h1>
          <p>This magic link is no longer valid. Please check your email for the latest link or contact support.</p>
        </body>
        </html>
        `,
        {
          status: 403,
          headers: { 'Content-Type': 'text/html' },
        }
      );
    }

    const ticketData: TicketData = await eventsResponse.json();

    // Check if event hasn't ended (with 24 hour buffer)
    const eventStartsAt = new Date(ticketData.event.startsAt);
    const eventEndTime = new Date(eventStartsAt.getTime() + 24 * 60 * 60 * 1000); // +24 hours
    const now = new Date();

    if (now > eventEndTime) {
      return new NextResponse(
        `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Event Ended</title>
          <style>
            body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
            h1 { color: #f97316; }
          </style>
        </head>
        <body>
          <h1>Event Has Ended</h1>
          <p>The event "${ticketData.event.title}" has concluded. This magic link is no longer active.</p>
        </body>
        </html>
        `,
        {
          status: 403,
          headers: { 'Content-Type': 'text/html' },
        }
      );
    }

    // Look up or create identity for the ticket owner
    const ownerDid = ticketData.ticket.ownerDid;

    let [identity] = await db
      .select()
      .from(identities)
      .where(eq(identities.id, ownerDid))
      .limit(1);

    if (!identity) {
      // Create new identity for the ticket owner
      // This should have been created during soft registration, but create if missing
      log.info({ ownerDid }, 'Creating identity (not found in auth DB)');

      [identity] = await db
        .insert(identities)
        .values({
          id: ownerDid,
          scope: 'actor',
          subtype: 'human',
          publicKey: `soft_${ownerDid}`, // Placeholder for soft identities
          metadata: { tier: 'soft', source: 'magic_link' },
        })
        .returning();
    }

    const identityTier = (identity.tier || 'soft') as 'soft' | 'preliminary' | 'established';

    // Create session token
    const sessionToken = await createSessionToken({
      sub: ownerDid,
      scope: 'actor',
      subtype: 'human',
      tier: identityTier,
      handle: identity.handle || undefined,
      name: identity.name || undefined,
    });

    // Set session cookie
    const cookieOptions = getSessionCookieOptions();

    const response = NextResponse.redirect(`${EVENTS_URL}/${ticketData.ticket.eventId}`);

    response.cookies.set(
      cookieOptions.name,
      sessionToken,
      cookieOptions.options
    );

    emitSessionAttestation({
      did: ownerDid,
      method: "magic_link",
      tier: identityTier,
      userAgent: request.headers.get("user-agent"),
    }).catch(err => log.error({ err: String(err) }, 'Session attestation error'));

    return response;

  } catch (error) {
    log.error({ err: String(error) }, 'Magic link authentication error');

    return new NextResponse(
      `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Authentication Error</title>
        <style>
          body { font-family: system-ui; max-width: 600px; margin: 50px auto; padding: 20px; text-align: center; }
          h1 { color: #ef4444; }
        </style>
      </head>
      <body>
        <h1>Authentication Error</h1>
        <p>Something went wrong while authenticating your ticket. Please try again or contact support.</p>
        <p style="font-size: 12px; color: #666;">Please try again or contact support if the issue persists.</p>
      </body>
      </html>
      `,
      {
        status: 500,
        headers: { 'Content-Type': 'text/html' },
      }
    );
  }
}
