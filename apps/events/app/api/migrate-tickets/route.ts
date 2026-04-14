/**
 * POST /events/api/migrate-tickets
 *
 * Internal endpoint: migrate tickets from soft DIDs to a hard DID.
 * Called by kernel/onboard/verify after email verification.
 * Idempotent — safe to call multiple times.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@imajin/logger';
import { db, tickets } from '@/src/db';
import { and, sql } from 'drizzle-orm';

const log = createLogger('events');

const INTERNAL_SECRET = process.env.INTERNAL_SECRET;

export async function POST(request: NextRequest) {
  // Validate shared secret if configured
  if (INTERNAL_SECRET) {
    const authHeader = request.headers.get('authorization');
    if (authHeader !== `Bearer ${INTERNAL_SECRET}`) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  try {
    const { email, hardDid } = await request.json();

    if (!email || !hardDid) {
      return NextResponse.json({ error: 'email and hardDid are required' }, { status: 400 });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Find all tickets across all events where:
    // - purchaseEmail matches
    // - owner is a soft DID (tier = 'soft' in auth.identities)
    // - owner is not already the hard DID
    const softTickets = await db
      .select({ id: tickets.id, ownerDid: tickets.ownerDid })
      .from(tickets)
      .where(
        and(
          sql`${tickets.metadata}->>'purchaseEmail' = ${normalizedEmail}`,
          sql`${tickets.ownerDid} != ${hardDid}`,
          sql`EXISTS (
            SELECT 1 FROM auth.identities
            WHERE auth.identities.id = ${tickets.ownerDid}
            AND (auth.identities.tier = 'soft' OR auth.identities.tier IS NULL)
          )`
        )
      );

    if (softTickets.length === 0) {
      log.info({ email: normalizedEmail, hardDid }, 'No soft DID tickets to migrate');
      return NextResponse.json({ migrated: 0 });
    }

    const softDids = Array.from(new Set(softTickets.map(t => t.ownerDid)));

    // Migrate all matching tickets to hard DID
    await db
      .update(tickets)
      .set({ ownerDid: hardDid })
      .where(
        and(
          sql`${tickets.metadata}->>'purchaseEmail' = ${normalizedEmail}`,
          sql`${tickets.ownerDid} != ${hardDid}`,
          sql`EXISTS (
            SELECT 1 FROM auth.identities
            WHERE auth.identities.id = ${tickets.ownerDid}
            AND (auth.identities.tier = 'soft' OR auth.identities.tier IS NULL)
          )`
        )
      );

    log.info(
      { count: softTickets.length, softDids, hardDid, email: normalizedEmail },
      'Migrated tickets from soft DIDs to hard DID'
    );

    // Migrate chat participation for each soft DID
    const CHAT_URL = process.env.CHAT_SERVICE_URL || process.env.CHAT_URL;
    if (CHAT_URL) {
      for (const softDid of softDids) {
        try {
          await fetch(`${CHAT_URL}/api/participants/migrate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fromDid: softDid, toDid: hardDid }),
          });
          log.info({ softDid, hardDid }, 'Migrated chat participation');
        } catch (chatError) {
          log.warn({ softDid, err: String(chatError) }, 'Chat migration failed (non-fatal)');
        }
      }
    }

    return NextResponse.json({ migrated: softTickets.length });

  } catch (error) {
    log.error({ err: String(error) }, 'migrate-tickets error');
    return NextResponse.json({ error: 'Migration failed' }, { status: 500 });
  }
}
