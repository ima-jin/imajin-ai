/**
 * POST /api/participants/migrate
 * 
 * Migrate all chat data from one DID to another.
 * Used when a soft DID (guest buyer) is claimed by a hard DID (logged-in user).
 * 
 * Body: { fromDid: string, toDid: string }
 * 
 * Updates: participants, messages, read receipts, reactions.
 * Handles duplicate participant conflicts (soft + hard DID in same conversation).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db';
import { sql } from 'drizzle-orm';

export async function POST(req: NextRequest) {
  try {
    const { fromDid, toDid } = await req.json();

    if (!fromDid || !toDid || fromDid === toDid) {
      return NextResponse.json({ error: 'fromDid and toDid required and must differ' }, { status: 400 });
    }

    const results = {
      participants: 0,
      participantsRemoved: 0,
      messages: 0,
      readReceipts: 0,
      conversationReads: 0,
      reactions: 0,
    };

    // 1. Migrate participants — handle conflicts where toDid already exists in the conversation
    // First, delete fromDid entries where toDid is already a participant (avoid PK conflict)
    const dupes = await db.execute(sql`
      DELETE FROM chat_participants
      WHERE did = ${fromDid}
        AND conversation_id IN (
          SELECT conversation_id FROM chat_participants WHERE did = ${toDid}
        )
    `);
    results.participantsRemoved = (dupes as any)?.rowCount ?? 0;

    // Then migrate remaining
    const partResult = await db.execute(sql`
      UPDATE chat_participants SET did = ${toDid} WHERE did = ${fromDid}
    `);
    results.participants = (partResult as any)?.rowCount ?? 0;

    // 2. Migrate messages
    const msgResult = await db.execute(sql`
      UPDATE chat_messages SET from_did = ${toDid} WHERE from_did = ${fromDid}
    `);
    results.messages = (msgResult as any)?.rowCount ?? 0;

    // 3. Migrate read receipts (handle PK conflicts by deleting dupes first)
    await db.execute(sql`
      DELETE FROM chat_read_receipts
      WHERE did = ${fromDid}
        AND conversation_id IN (
          SELECT conversation_id FROM chat_read_receipts WHERE did = ${toDid}
        )
    `);
    const rrResult = await db.execute(sql`
      UPDATE chat_read_receipts SET did = ${toDid} WHERE did = ${fromDid}
    `);
    results.readReceipts = (rrResult as any)?.rowCount ?? 0;

    // 4. Migrate conversation reads (same pattern)
    await db.execute(sql`
      DELETE FROM conversation_reads
      WHERE did = ${fromDid}
        AND conversation_id IN (
          SELECT conversation_id FROM conversation_reads WHERE did = ${toDid}
        )
    `);
    const crResult = await db.execute(sql`
      UPDATE conversation_reads SET did = ${toDid} WHERE did = ${fromDid}
    `);
    results.conversationReads = (crResult as any)?.rowCount ?? 0;

    // 5. Migrate reactions (handle PK conflicts)
    await db.execute(sql`
      DELETE FROM chat_message_reactions
      WHERE did = ${fromDid}
        AND message_id IN (
          SELECT message_id FROM chat_message_reactions WHERE did = ${toDid}
        )
    `);
    const rxResult = await db.execute(sql`
      UPDATE chat_message_reactions SET did = ${toDid} WHERE did = ${fromDid}
    `);
    results.reactions = (rxResult as any)?.rowCount ?? 0;

    console.log(`DID migration ${fromDid} → ${toDid}:`, results);

    return NextResponse.json({ migrated: true, ...results });
  } catch (error) {
    console.error('Participant migration error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Migration failed' },
      { status: 500 }
    );
  }
}
