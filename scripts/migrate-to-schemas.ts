#!/usr/bin/env tsx
/**
 * Migrate tables from public schema to service-specific schemas
 *
 * Run this ONCE to migrate existing production data.
 * Safe to run multiple times - skips tables already in target schema.
 */

import postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is required');
  process.exit(1);
}

const sql = postgres(DATABASE_URL);

// Map tables to their target schemas
const TABLE_MIGRATIONS: Record<string, string> = {
  // Auth
  'auth_identities': 'auth',
  'auth_challenges': 'auth',
  'auth_tokens': 'auth',

  // Chat
  'chat_conversations': 'chat',
  'chat_participants': 'chat',
  'chat_messages': 'chat',
  'chat_invites': 'chat',
  'chat_public_keys': 'chat',
  'chat_pre_keys': 'chat',
  'chat_read_receipts': 'chat',
  'conversation_reads': 'chat',
  'chat_message_reactions': 'chat',

  // Coffee
  'coffee_pages': 'coffee',
  'tips': 'coffee',

  // Dykil
  'surveys': 'dykil',
  'survey_responses': 'dykil',

  // Events
  'events': 'events',
  'ticket_types': 'events',
  'event_admins': 'events',
  'tickets': 'events',
  'ticket_transfers': 'events',
  'ticket_queue': 'events',

  // Links
  'link_pages': 'links',
  'links': 'links',
  'link_clicks': 'links',

  // Pay
  'transactions': 'pay',
  'balances': 'pay',
  'balance_rollups': 'pay',

  // Profile
  'profiles': 'profile',
  'connections': 'profile',
  'connection_requests': 'profile',
  'did_migrations': 'profile',

  // Registry
  'registry_nodes': 'registry',
  'registry_approved_builds': 'registry',
  'registry_heartbeats': 'registry',
  'registry_trust': 'registry',

  // WWW
  'www_contacts': 'www',
  'www_mailing_lists': 'www',
  'www_subscriptions': 'www',

  // Connections (trust-graph)
  'trust_pods': 'connections',
  'trust_pod_members': 'connections',
  'trust_pod_links': 'connections',
  'trust_pod_keys': 'connections',
  'trust_pod_member_keys': 'connections',
  'trust_invites': 'connections',
  'trust_graph_invites': 'connections',
};

async function main() {
  console.log('🚀 Starting schema migration...\n');

  // Get unique schema names
  const schemas = [...new Set(Object.values(TABLE_MIGRATIONS))];

  // Create all schemas
  console.log('📦 Creating schemas...');
  for (const schema of schemas) {
    try {
      await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      console.log(`  ✅ ${schema}`);
    } catch (error) {
      console.error(`  ❌ Failed to create schema ${schema}:`, error);
    }
  }

  console.log('\n📋 Migrating tables...');
  let migrated = 0;
  let skipped = 0;
  let errors = 0;

  for (const [tableName, targetSchema] of Object.entries(TABLE_MIGRATIONS)) {
    try {
      // Check if table exists in public schema
      const publicExists = await sql`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public'
          AND table_name = ${tableName}
        );
      `;

      if (!publicExists[0].exists) {
        // Check if it's already in the target schema
        const targetExists = await sql`
          SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = ${targetSchema}
            AND table_name = ${tableName.replace(/^(auth_|chat_|coffee_|link_|registry_|www_|trust_|trust_pod_|trust_graph_)/, '')}
          );
        `;

        if (targetExists[0].exists) {
          console.log(`  ⏭️  ${tableName} → already in ${targetSchema}`);
          skipped++;
        } else {
          console.log(`  ⚠️  ${tableName} → not found in public or ${targetSchema}`);
          skipped++;
        }
        continue;
      }

      // Migrate table to target schema
      await sql.unsafe(`ALTER TABLE public.${tableName} SET SCHEMA ${targetSchema}`);
      console.log(`  ✅ ${tableName} → ${targetSchema}`);
      migrated++;
    } catch (error) {
      console.error(`  ❌ Failed to migrate ${tableName}:`, error);
      errors++;
    }
  }

  // Step 3: Rename tables to drop prefixes (auth.auth_identities → auth.identities)
  console.log('\n📝 Renaming tables (dropping prefixes)...');
  const TABLE_RENAMES: Record<string, Record<string, string>> = {
    auth: { auth_identities: 'identities', auth_challenges: 'challenges', auth_tokens: 'tokens' },
    chat: {
      chat_conversations: 'conversations', chat_participants: 'participants',
      chat_messages: 'messages', chat_invites: 'invites', chat_public_keys: 'public_keys',
      chat_pre_keys: 'pre_keys', chat_read_receipts: 'read_receipts',
      chat_message_reactions: 'message_reactions',
    },
    coffee: { coffee_pages: 'pages' },
    connections: {
      trust_pods: 'pods', trust_pod_members: 'pod_members', trust_pod_links: 'pod_links',
      trust_pod_keys: 'pod_keys', trust_pod_member_keys: 'pod_member_keys',
      trust_invites: 'invites', trust_graph_invites: 'graph_invites',
    },
    registry: {
      registry_nodes: 'nodes', registry_approved_builds: 'approved_builds',
      registry_heartbeats: 'heartbeats', registry_trust: 'trust',
    },
    www: { www_contacts: 'contacts', www_mailing_lists: 'mailing_lists', www_subscriptions: 'subscriptions' },
  };

  let renamed = 0;
  for (const [schema, renames] of Object.entries(TABLE_RENAMES)) {
    for (const [oldName, newName] of Object.entries(renames)) {
      try {
        const exists = await sql`
          SELECT EXISTS (
            SELECT FROM information_schema.tables
            WHERE table_schema = ${schema} AND table_name = ${oldName}
          );
        `;
        if (exists[0].exists) {
          await sql.unsafe(`ALTER TABLE ${schema}.${oldName} RENAME TO ${newName}`);
          console.log(`  ✅ ${schema}.${oldName} → ${schema}.${newName}`);
          renamed++;
        }
      } catch (error) {
        console.error(`  ❌ Failed to rename ${schema}.${oldName}:`, error);
      }
    }
  }

  console.log('\n📊 Migration Summary:');
  console.log(`  ✅ Migrated: ${migrated}`);
  console.log(`  📝 Renamed: ${renamed}`);
  console.log(`  ⏭️  Skipped: ${skipped}`);
  console.log(`  ❌ Errors: ${errors}`);

  await sql.end();
  console.log('\n✨ Migration complete!');
}

main().catch((error) => {
  console.error('💥 Migration failed:', error);
  process.exit(1);
});
