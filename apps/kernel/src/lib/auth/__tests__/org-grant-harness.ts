import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import * as schema from '@/src/db/schemas/auth';

/** Real grant migrations; attestation/member columns mirror the existing auth schema. */
export async function createOrgGrantHarness() {
  const client = new PGlite();
  await client.waitReady;
  await client.exec(`
    CREATE SCHEMA auth;
    CREATE TABLE auth.identities (
      id text PRIMARY KEY, public_key text NOT NULL UNIQUE, scope text NOT NULL, subtype text, name text, handle text, suspended_at timestamptz
    );
    CREATE TABLE auth.identity_members (
      identity_did text NOT NULL, member_did text NOT NULL, role text NOT NULL DEFAULT 'member',
      allowed_services text[], added_by text, added_via text, added_at timestamptz DEFAULT now(),
      removed_at timestamptz, opt_in_ref text
    );
    CREATE TABLE auth.attestations (
      id text PRIMARY KEY, issuer_did text NOT NULL, subject_did text NOT NULL,
      type text NOT NULL, context_id text, context_type text, payload jsonb,
      signature text NOT NULL, cid text, nostr_sig text, author_jws text, witness_jws text,
      attestation_status text DEFAULT 'pending', document_hash text, document_asset_id text,
      total_signers integer, delegator_did text, disclosure_scope text NOT NULL DEFAULT 'parties',
      prev_event_ref text, delegation_grant_id text, supersedes text, ref text,
      issued_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz,
      revoked_at timestamptz, lapsed_at timestamptz
    );
  `);
  for (const name of ['0099_delegation_grants.sql', '0104_delegation_grant_audit.sql', '0217_grant_revocation_audit_retry.sql', '0217_grant_revocation_audit_retry.sql']) {
    // Pre-baseline history lives in the archive (#2525); post-baseline files stay at the root.
    const dir = name.startsWith('0217_') ? 'migrations/' : 'migrations/archive/pre-kernel-baseline/';
    await client.exec(await readFile(new URL(`../../../../../../${dir}${name}`, import.meta.url), 'utf8'));
  }
  const db = drizzle(client, { schema });
  return {
    client,
    db,
    async reset() {
      await client.exec('TRUNCATE auth.delegation_grants, auth.delegation_grant_capabilities, auth.delegation_grant_events, auth.attestations, auth.identity_members, auth.identities CASCADE');
    },
    async snapshot() {
      // Compare all columns, not just counts: a rejected request must not renew,
      // revoke, or alter an existing row either.
      const tables = ['delegation_grants', 'delegation_grant_capabilities', 'delegation_grant_events', 'attestations', 'identity_members'];
      return Promise.all(tables.map(async (table) =>
        (await client.query(`SELECT * FROM auth.${table} ORDER BY 1`)).rows));
    },
    close: () => client.close(),
  };
}
