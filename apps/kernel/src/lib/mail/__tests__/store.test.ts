import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { mailSenders } from '@/src/db/schemas/mail';
import { registryApps } from '@/src/db/schemas/registry';
import type { SenderConfig } from '../types';

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/src/db', async () => ({
  db: new Proxy({}, { get: (_target, prop) => Reflect.get(state.db as object, prop) }),
  ...await import('@/src/db/schemas/mail'), ...await import('@/src/db/schemas/registry'),
}));
import { listSenderConfigs, saveSenderConfig, resolveMailOwner } from '../store';

const client = new PGlite();
const config: SenderConfig = {
  ownerDid: 'did:imajin:owner', appDid: '', purpose: 'signin', domain: 'EXAMPLE.COM',
  localPart: 'signin', displayName: 'Owner', replyTo: null,
};
beforeAll(async () => {
  state.db = drizzle(client, { schema: { mailSenders, registryApps } });
  await client.exec(`CREATE SCHEMA registry; CREATE TABLE registry.apps
    (owner_did text NOT NULL, app_did text PRIMARY KEY, status text NOT NULL, revoked_at timestamptz);`);
  const migration = readFileSync(new URL('../../../../../../migrations/0210_mail_senders.sql', import.meta.url), 'utf8');
  await client.exec(migration);
  await client.exec(migration);
});
beforeEach(async () => { await client.exec('TRUNCATE kernel.mail_senders, registry.apps'); });
afterAll(async () => { await client.close(); });
describe('sender configuration persistence', () => {
  it('replays migration twice and constrains the purpose vocabulary in SQL', async () => {
    await expect(client.query(`INSERT INTO kernel.mail_senders VALUES ('owner','made-up','','example.com','x','X',null)`)).rejects.toThrow();
  });
  it('upserts only exact owner/purpose/app keys, normalizes domain and isolates reads', async () => {
    await saveSenderConfig(config);
    await saveSenderConfig({ ...config, displayName: 'Updated', replyTo: 'reply@example.com' });
    await saveSenderConfig({ ...config, ownerDid: 'did:imajin:other', purpose: 'receipts' });
    expect(await listSenderConfigs(config.ownerDid)).toEqual([{ ...config, domain: 'example.com', displayName: 'Updated', replyTo: 'reply@example.com' }]);
    expect(await listSenderConfigs('did:imajin:unknown')).toEqual([]);
  });
  it('derives app owner from registry, refusing cross-owner config writes', async () => {
    await client.query('INSERT INTO registry.apps VALUES ($1,$2,$3,null)', [config.ownerDid, 'did:imajin:app', 'active']);
    expect(await resolveMailOwner(undefined, 'did:imajin:app')).toBe(config.ownerDid);
    await saveSenderConfig({ ...config, appDid: 'did:imajin:app' });
    await expect(saveSenderConfig({ ...config, appDid: 'did:imajin:app', ownerDid: 'did:imajin:other' })).rejects.toThrow('owner');
    expect((await listSenderConfigs(config.ownerDid))[0].appDid).toBe('did:imajin:app');
    expect(await listSenderConfigs('did:imajin:other')).toEqual([]);
  });
  it.each(['revoked', 'missing', 'revoked-at'])('refuses %s app before writing', async kind => {
    if (kind !== 'missing') await client.query('INSERT INTO registry.apps VALUES ($1,$2,$3,$4)', [
      config.ownerDid, 'did:imajin:app', kind === 'revoked' ? 'revoked' : 'active', kind === 'revoked-at' ? new Date().toISOString() : null,
    ]);
    await expect(saveSenderConfig({ ...config, appDid: 'did:imajin:app' })).rejects.toThrow();
    expect(await listSenderConfigs(config.ownerDid)).toEqual([]);
  });
  it('validates configurations before any persistent write', async () => {
    await expect(saveSenderConfig({ ...config, domain: 'https://example.com' })).rejects.toThrow();
    expect(await listSenderConfigs(config.ownerDid)).toEqual([]);
  });
});
