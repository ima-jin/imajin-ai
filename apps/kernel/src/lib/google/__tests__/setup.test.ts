import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { identities } from '@/src/db/schemas/auth';
import { eq } from 'drizzle-orm';

const database = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('@/src/db', async () => ({
  db: new Proxy({}, { get: (_target, property) => {
    const db = database.db as Record<string | symbol, unknown>;
    const value = db[property];
    return typeof value === 'function' ? value.bind(db) : value;
  } }),
  identities: (await import('@/src/db/schemas/auth')).identities,
}));

import { decodeGoogleSetup, nextGoogleSetupStep, readGoogleSetup, requireBusinessProfileApproval, resetBusinessProfileApproval, updateGoogleSetup } from '../setup';
import { withConnectorConnection } from '@/src/lib/kernel/connector-connection-context';

const client = new PGlite();
const db = drizzle(client);
const owner = 'did:imajin:org-one';
const other = 'did:imajin:org-two';

beforeAll(async () => {
  database.db = db;
  await client.exec('CREATE SCHEMA auth; CREATE TABLE auth.identities (id text PRIMARY KEY, metadata jsonb, updated_at timestamptz)');
});
beforeEach(async () => {
  await client.exec('TRUNCATE auth.identities');
  await client.query('INSERT INTO auth.identities (id, metadata) VALUES ($1, $2), ($3, $2)', [owner, JSON.stringify({ existing: 'preserved' }), other]);
});
afterAll(async () => { await client.close(); });

describe('Google guided setup metadata', () => {
  it('defaults all six steps safely for absent or malformed metadata', () => {
    for (const input of [undefined, null, [], {}, { steps: { project: { status: '__proto__' } } }]) {
      const state = decodeGoogleSetup(input);
      expect(state.version).toBe(1);
      expect(Object.keys(state.steps)).toHaveLength(6);
      expect(state.steps.project).toEqual({ status: 'not_started', updatedAt: null, pendingSince: null });
    }
  });

  it('retains pending-since while pending, clears on failure, starts a fresh waiting period', () => {
    const first = nextGoogleSetupStep(decodeGoogleSetup(null).steps.project, 'pending_google', '2026-10-17T00:00:00Z');
    const repeated = nextGoogleSetupStep(first, 'pending_google', '2026-10-18T00:00:00Z');
    expect(repeated.pendingSince).toBe(first.pendingSince);
    const failed = nextGoogleSetupStep(repeated, 'failed', '2026-10-19T00:00:00Z');
    expect(failed.pendingSince).toBeNull();
    expect(nextGoogleSetupStep(failed, 'pending_google', '2026-10-20T00:00:00Z').pendingSince).toBe('2026-10-20T00:00:00Z');
  });

  it('persists pending status and case across reloads without overwriting other steps, slots, or metadata', async () => {
    const saved = await updateGoogleSetup(owner, 'work', 'business-access', 'pending_google', 'https://support.google.com/business/thread/123');
    await updateGoogleSetup(owner, 'work', 'project', 'approved');
    await updateGoogleSetup(owner, 'personal', 'project', 'submitted');
    const reloaded = await readGoogleSetup(owner, 'work');
    expect(reloaded.steps['business-access']).toEqual(saved.steps['business-access']);
    expect(reloaded.steps.project.status).toBe('approved');
    expect((await readGoogleSetup(owner, 'personal')).steps.project.status).toBe('submitted');
    expect((await readGoogleSetup(other, 'work')).steps['business-access'].status).toBe('not_started');
    const [row] = await db.select({ metadata: identities.metadata }).from(identities).where(eq(identities.id, owner));
    expect(row.metadata).toMatchObject({ existing: 'preserved' });
  });

  it('requires explicit Business approval for precisely the selected identity and slot', async () => {
    await expect(requireBusinessProfileApproval(owner, 'work')).rejects.toThrow('google_business_profile_approval_pending');
    await updateGoogleSetup(owner, 'work', 'business-access', 'submitted');
    await expect(requireBusinessProfileApproval(owner, 'work')).rejects.toThrow('google_business_profile_approval_pending');
    await updateGoogleSetup(owner, 'work', 'business-access', 'approved');
    await withConnectorConnection('google', owner, 'work', () => expect(requireBusinessProfileApproval(owner)).resolves.toBeUndefined());
    await expect(requireBusinessProfileApproval(owner, 'primary')).rejects.toThrow('google_business_profile_approval_pending');
    await expect(requireBusinessProfileApproval(other, 'work')).rejects.toThrow('google_business_profile_approval_pending');
    await updateGoogleSetup(owner, 'work', 'business-access', 'failed');
    await expect(requireBusinessProfileApproval(owner, 'work')).rejects.toThrow('google_business_profile_approval_pending');
  });

  it('fails a write to a missing identity and rejects malformed slots', async () => {
    await expect(updateGoogleSetup('did:imajin:missing', 'work', 'project', 'approved')).rejects.toThrow('google_setup_identity_missing');
    await expect(readGoogleSetup(owner, '../work')).rejects.toThrow('invalid_connection');
  });

  it('preserves saved case metadata when editing status without resubmitting the link', async () => {
    await updateGoogleSetup(owner, 'work', 'business-access', 'submitted', 'https://support.google.com/business/thread/123');
    const saved = await updateGoogleSetup(owner, 'work', 'business-access', 'pending_google');
    expect(saved.steps['business-access'].caseUrl).toBe('https://support.google.com/business/thread/123');
  });

  it('resets approved Business access only for the replaced client identity and slot', async () => {
    await updateGoogleSetup(owner, 'work', 'business-access', 'approved', 'https://support.google.com/business/thread/123');
    await updateGoogleSetup(owner, 'personal', 'business-access', 'approved');
    await updateGoogleSetup(other, 'work', 'business-access', 'approved');
    await resetBusinessProfileApproval(owner, 'work');
    expect((await readGoogleSetup(owner, 'work')).steps['business-access']).toMatchObject({
      status: 'not_started', caseUrl: 'https://support.google.com/business/thread/123',
    });
    expect((await readGoogleSetup(owner, 'personal')).steps['business-access'].status).toBe('approved');
    expect((await readGoogleSetup(other, 'work')).steps['business-access'].status).toBe('approved');
    await updateGoogleSetup(owner, 'work', 'business-access', 'pending_google');
    const pending = await readGoogleSetup(owner, 'work');
    await resetBusinessProfileApproval(owner, 'work');
    expect(await readGoogleSetup(owner, 'work')).toEqual(pending);
  });
});
