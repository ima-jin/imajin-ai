import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

vi.setConfig({ testTimeout: 30_000 });
const migration = (name: string) => readFileSync(resolve(__dirname, '../../../../../../migrations', name), 'utf8');
let client: PGlite;
afterEach(async () => { await client?.close(); });

describe('0197 connection slots on populated historical schemas', () => {
  it('preserves primary identities and credentials, isolates second installations, and reruns safely', async () => {
    client = new PGlite();
    await client.exec('CREATE SCHEMA auth; CREATE SCHEMA kernel;');
    for (const name of [
      '0044_channel_links.sql', '0063_vault_delegation_grants.sql',
      '0073_github_action_proposals.sql', '0088_quickbooks_realm_index.sql',
      '0114_connectors_registry.sql', '0136_google_workspace_state.sql',
      '0140_google_workspace_state_gmail_email.sql',
    ]) await client.exec(migration(name));
    await client.exec(`
      INSERT INTO kernel.connectors
        (id, owner_did, provider, channel, connector_did, sealed_key_field, scopes, spend_cap)
      VALUES ('conn_legacy', 'did:owner', 'google', 'google', 'did:google',
        'google-oauth:did:owner', '["google:gmail-read"]', '{"amountUsd":20}');
      INSERT INTO auth.channel_links (id, channel, channel_uid, did, app_did, scopes)
        VALUES ('clink_legacy', 'google', 'asset_legacy#google:gmail-read', 'did:owner', 'did:google', '["google:gmail-read"]');
      INSERT INTO kernel.vault_delegation_grants
        (id, subject, granted_to, field, owner_x_pub, wrapped_key, wrapped_nonce, key_id, owner_signature)
        VALUES ('grant_fixture', 'did:owner', 'did:node', 'google-oauth:did:owner',
          'fixture-pub', 'fixture-wrapped', 'fixture-nonce', 'fixture-key-id', 'fixture-signature');
      INSERT INTO kernel.google_workspace_state (id, owner_did, gmail_history_id, gmail_email_address, drive_page_token)
        VALUES ('gws_legacy', 'did:owner', '100', 'personal@example.test', 'personal-cursor');
      INSERT INTO kernel.quickbooks_realm_index (realm_id, owner_did, app_did)
        VALUES ('realm_legacy', 'did:owner', 'did:app');
      INSERT INTO github.action_proposals (id, owner_did, scope, tool, risk_tier, target, args_summary, status)
        VALUES ('proposal_legacy', 'did:owner', 'github:write', 'github_update_issue', 'mutate', 'repo#1', 'fixture', 'approved');
    `);
    const custodyBefore = (await client.query('SELECT * FROM kernel.vault_delegation_grants')).rows;
    const sql = migration('0197_connector_connection_slots.sql');
    await client.exec(sql);
    expect((await client.query('SELECT id, slot, sealed_key_field, scopes, spend_cap FROM kernel.connectors')).rows).toEqual([{
      id: 'conn_legacy', slot: 'primary', sealed_key_field: 'google-oauth:did:owner',
      scopes: ['google:gmail-read'], spend_cap: { amountUsd: 20 },
    }]);
    expect((await client.query('SELECT id, slot, gmail_history_id, drive_page_token FROM kernel.google_workspace_state')).rows[0])
      .toEqual({ id: 'gws_legacy', slot: 'primary', gmail_history_id: '100', drive_page_token: 'personal-cursor' });
    for (const table of ['auth.channel_links', 'kernel.quickbooks_realm_index', 'github.action_proposals']) {
      expect((await client.query(`SELECT slot FROM ${table}`)).rows).toEqual([{ slot: 'primary' }]);
    }
    await client.exec(`
      INSERT INTO kernel.connectors (id, owner_did, provider, channel, connector_did, slot, label)
        VALUES ('conn_work', 'did:owner', 'google', 'google', 'did:google', 'work', 'Work');
      INSERT INTO kernel.google_workspace_state (id, owner_did, slot, drive_page_token)
        VALUES ('gws_work', 'did:owner', 'work', 'work-cursor');
      INSERT INTO auth.channel_links (id, channel, channel_uid, did, app_did, slot, scopes)
        VALUES ('clink_work', 'google', 'asset_work#google:gmail-read', 'did:owner', 'did:google', 'work', '["google:gmail-read"]');
      UPDATE auth.channel_links SET status='revoked' WHERE did='did:owner' AND slot='work';
      UPDATE kernel.google_workspace_state SET drive_page_token='next-work' WHERE owner_did='did:owner' AND slot='work';
    `);
    expect((await client.query("SELECT status FROM auth.channel_links WHERE slot='primary'")).rows).toEqual([{ status: 'active' }]);
    expect((await client.query("SELECT drive_page_token FROM kernel.google_workspace_state WHERE slot='primary'")).rows)
      .toEqual([{ drive_page_token: 'personal-cursor' }]);
    expect((await client.query("SELECT sealed_key_field, scopes FROM kernel.connectors WHERE slot='work'")).rows)
      .toEqual([{ sealed_key_field: null, scopes: [] }]);
    await expect(client.exec(`INSERT INTO kernel.connectors (id, owner_did, provider, channel, connector_did, slot)
      VALUES ('duplicate', 'did:owner', 'google', 'google', 'did:google', 'work')`)).rejects.toThrow();
    await expect(client.exec(`INSERT INTO kernel.google_workspace_state (id, owner_did, slot)
      VALUES ('duplicate', 'did:owner', 'work')`)).rejects.toThrow();
    await client.exec(sql);
    expect((await client.query('SELECT * FROM kernel.vault_delegation_grants')).rows).toEqual(custodyBefore);
    expect((await client.query('SELECT count(*)::int AS count FROM kernel.connectors')).rows).toEqual([{ count: 2 }]);
  });
});
