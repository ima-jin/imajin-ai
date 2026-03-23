/**
 * migrate-v1-to-v2.ts
 *
 * Migrates all v1 chat data (conversations/participants/messages/etc.)
 * into v2 DID-keyed tables.
 *
 * Usage:
 *   npx tsx scripts/migrate-v1-to-v2.ts [--dry-run]
 *
 * Idempotent — safe to run multiple times.
 */

import { getClient } from '@imajin/db';
import { dmDid, groupDid } from '../src/lib/conversation-did';

const DRY_RUN = process.argv.includes('--dry-run');

const sql = getClient();

interface V1Conversation {
  id: string;
  type: string;
  name: string | null;
  context: Record<string, unknown> | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
  last_message_at: Date | null;
}

interface V1Participant {
  conversation_id: string;
  did: string;
  role: string;
}

interface V1Message {
  id: string;
  conversation_id: string;
  from_did: string;
  content: unknown;
  content_type: string;
  media_type: string | null;
  media_path: string | null;
  media_meta: unknown;
  reply_to: string | null;
  link_previews: unknown;
  created_at: Date;
  edited_at: Date | null;
  deleted_at: Date | null;
}

interface V1Reaction {
  message_id: string;
  did: string;
  emoji: string;
  created_at: Date;
}

interface V1Read {
  conversation_id: string;
  did: string;
  last_read_at: Date;
}

async function main() {
  console.log(`\n=== Chat V1 → V2 Migration${DRY_RUN ? ' (DRY RUN)' : ''} ===\n`);

  const summary = {
    conversations: { processed: 0, created: 0, skipped: 0 },
    messages: { processed: 0, created: 0, skipped: 0 },
    reactions: { processed: 0, created: 0, skipped: 0 },
    reads: { processed: 0, created: 0, skipped: 0 },
  };

  // 1. Load all v1 conversations
  const v1Convs = await sql<V1Conversation[]>`
    SELECT id, type, name, context, created_by, created_at, updated_at, last_message_at
    FROM chat.conversations
    ORDER BY created_at ASC
  `;

  console.log(`Found ${v1Convs.length} v1 conversations`);

  // Map from v1 conversation_id → derived conversation_did
  const convIdToDidMap = new Map<string, string>();

  for (const conv of v1Convs) {
    summary.conversations.processed++;

    // Load participants for this conversation
    const participants = await sql<V1Participant[]>`
      SELECT conversation_id, did, role
      FROM chat.participants
      WHERE conversation_id = ${conv.id}
    `;

    const memberDids = participants.map((p) => p.did);

    // Derive conversation DID
    let conversationDid: string;

    if (conv.type === 'direct') {
      if (memberDids.length < 2) {
        console.warn(`  SKIP conv ${conv.id}: direct with <2 participants (${memberDids.join(', ')})`);
        summary.conversations.skipped++;
        continue;
      }
      conversationDid = dmDid(memberDids[0], memberDids[1]);
    } else if (conv.type === 'group') {
      // Check if this is an event lobby via context
      const ctx = conv.context as Record<string, unknown> | null;
      if (ctx?.type === 'event' && typeof ctx.id === 'string') {
        // Use the event DID directly
        conversationDid = `did:imajin:event:${ctx.id}`;
      } else if (memberDids.length > 0) {
        conversationDid = groupDid(memberDids);
      } else {
        // Fallback: use a stable hash of the v1 id
        conversationDid = `did:imajin:group:${conv.id}`;
      }
    } else {
      console.warn(`  SKIP conv ${conv.id}: unknown type '${conv.type}'`);
      summary.conversations.skipped++;
      continue;
    }

    convIdToDidMap.set(conv.id, conversationDid);

    // Check if v2 row already exists
    const existing = await sql`
      SELECT did FROM chat.conversations_v2 WHERE did = ${conversationDid} LIMIT 1
    `;

    if (existing.length > 0) {
      console.log(`  SKIP conv ${conv.id} → ${conversationDid} (already exists)`);
      summary.conversations.skipped++;
    } else {
      console.log(`  UPSERT conv ${conv.id} → ${conversationDid}`);
      if (!DRY_RUN) {
        await sql`
          INSERT INTO chat.conversations_v2 (did, type, name, context, visibility, created_by, created_at, updated_at, last_message_at)
          VALUES (
            ${conversationDid},
            ${conv.type === 'direct' ? 'dm' : (conv.type || 'dm')},
            ${conv.name},
            ${JSON.stringify(conv.context || {})},
            ${'private'},
            ${conv.created_by},
            ${conv.created_at},
            ${conv.updated_at},
            ${conv.last_message_at}
          )
          ON CONFLICT (did) DO NOTHING
        `;
      }
      summary.conversations.created++;
    }
  }

  console.log(`\nConversation mapping built: ${convIdToDidMap.size} entries`);

  // 2. Copy messages
  console.log('\n--- Migrating messages ---');

  for (const [v1ConvId, convDid] of convIdToDidMap.entries()) {
    const msgs = await sql<V1Message[]>`
      SELECT id, conversation_id, from_did, content, content_type,
             media_type, media_path, media_meta, reply_to, link_previews,
             created_at, edited_at, deleted_at
      FROM chat.messages
      WHERE conversation_id = ${v1ConvId}
      ORDER BY created_at ASC
    `;

    for (const msg of msgs) {
      summary.messages.processed++;

      // Check if already migrated
      const existing = await sql`
        SELECT id FROM chat.messages_v2 WHERE id = ${msg.id} LIMIT 1
      `;

      if (existing.length > 0) {
        summary.messages.skipped++;
        continue;
      }

      if (!DRY_RUN) {
        await sql`
          INSERT INTO chat.messages_v2 (
            id, conversation_did, from_did, content, content_type,
            media_type, media_path, media_meta, reply_to, link_previews,
            created_at, edited_at, deleted_at
          ) VALUES (
            ${msg.id},
            ${convDid},
            ${msg.from_did},
            ${msg.content as never},
            ${msg.content_type},
            ${msg.media_type},
            ${msg.media_path},
            ${msg.media_meta as never},
            ${msg.reply_to},
            ${msg.link_previews as never},
            ${msg.created_at},
            ${msg.edited_at},
            ${msg.deleted_at}
          )
          ON CONFLICT (id) DO NOTHING
        `;
      }
      summary.messages.created++;
    }
  }

  // 3. Copy message reactions
  console.log('\n--- Migrating reactions ---');

  for (const [v1ConvId] of convIdToDidMap.entries()) {
    const reactions = await sql<V1Reaction[]>`
      SELECT mr.message_id, mr.did, mr.emoji, mr.created_at
      FROM chat.message_reactions mr
      JOIN chat.messages m ON m.id = mr.message_id
      WHERE m.conversation_id = ${v1ConvId}
    `;

    for (const rxn of reactions) {
      summary.reactions.processed++;

      const existing = await sql`
        SELECT 1 FROM chat.message_reactions_v2
        WHERE message_id = ${rxn.message_id} AND did = ${rxn.did} AND emoji = ${rxn.emoji}
        LIMIT 1
      `;

      if (existing.length > 0) {
        summary.reactions.skipped++;
        continue;
      }

      // Only insert if the v2 message exists (was migrated)
      const msgExists = await sql`
        SELECT 1 FROM chat.messages_v2 WHERE id = ${rxn.message_id} LIMIT 1
      `;

      if (msgExists.length === 0) {
        summary.reactions.skipped++;
        continue;
      }

      if (!DRY_RUN) {
        await sql`
          INSERT INTO chat.message_reactions_v2 (message_id, did, emoji, created_at)
          VALUES (${rxn.message_id}, ${rxn.did}, ${rxn.emoji}, ${rxn.created_at})
          ON CONFLICT DO NOTHING
        `;
      }
      summary.reactions.created++;
    }
  }

  // 4. Copy conversation reads
  console.log('\n--- Migrating conversation reads ---');

  for (const [v1ConvId, convDid] of convIdToDidMap.entries()) {
    const reads = await sql<V1Read[]>`
      SELECT conversation_id, did, last_read_at
      FROM chat.conversation_reads
      WHERE conversation_id = ${v1ConvId}
    `;

    for (const read of reads) {
      summary.reads.processed++;

      const existing = await sql`
        SELECT 1 FROM chat.conversation_reads_v2
        WHERE conversation_did = ${convDid} AND did = ${read.did}
        LIMIT 1
      `;

      if (existing.length > 0) {
        summary.reads.skipped++;
        continue;
      }

      if (!DRY_RUN) {
        await sql`
          INSERT INTO chat.conversation_reads_v2 (conversation_did, did, last_read_at)
          VALUES (${convDid}, ${read.did}, ${read.last_read_at})
          ON CONFLICT DO NOTHING
        `;
      }
      summary.reads.created++;
    }
  }

  // Summary
  console.log('\n=== Migration Summary ===');
  console.log(`Conversations: ${summary.conversations.created} created, ${summary.conversations.skipped} skipped, ${summary.conversations.processed} processed`);
  console.log(`Messages:      ${summary.messages.created} created, ${summary.messages.skipped} skipped, ${summary.messages.processed} processed`);
  console.log(`Reactions:     ${summary.reactions.created} created, ${summary.reactions.skipped} skipped, ${summary.reactions.processed} processed`);
  console.log(`Reads:         ${summary.reads.created} created, ${summary.reads.skipped} skipped, ${summary.reads.processed} processed`);

  if (DRY_RUN) {
    console.log('\n(DRY RUN — no changes written)');
  } else {
    console.log('\nMigration complete.');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
