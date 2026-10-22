import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createOrgGrantHarness } from '@/src/lib/auth/__tests__/org-grant-harness';
import { delegationGrants, delegationGrantCapabilities } from '@/src/db/schemas/auth';
import { notifications, preferences } from '@/src/db/schemas/notify';

const mocks = vi.hoisted(() => ({ db: null as unknown, ws: vi.fn(), phone: vi.fn() }));
vi.mock('@/src/db', async () => ({
  ...await import('@/src/db/schemas/auth'),
  ...await import('@/src/db/schemas/notify'),
  get db() { return mocks.db; },
}));
vi.mock('../ws-push', () => ({ buildNotificationFrame: (input: unknown) => input, pushNotificationToDid: mocks.ws }));
vi.mock('../web-push', () => ({ pushWebNotificationToOperator: mocks.phone }));

import { notifyExpiringOperatorGrants } from '../grant-expiry';

const NOW = new Date('2026-10-21T00:00:00Z');
const DAY = 86400000;
const OWNER = 'did:imajin:expiry-owner';
let harness: Awaited<ReturnType<typeof createOrgGrantHarness>>;
let sequence = 0;

beforeAll(async () => {
  harness = await createOrgGrantHarness();
  mocks.db = harness.db;
  await harness.client.exec(`
    CREATE SCHEMA notify;
    CREATE TABLE notify.notifications (
      id text PRIMARY KEY, recipient_did text NOT NULL, sender_did text, scope text NOT NULL,
      urgency text NOT NULL DEFAULT 'normal', title text NOT NULL, body text, data jsonb DEFAULT '{}',
      channels_sent text[] DEFAULT '{}', read boolean DEFAULT false, read_at timestamptz,
      delivered_at timestamptz, ws_sent_at timestamptz, ws_attempts integer NOT NULL DEFAULT 0,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE notify.preferences (
      id text PRIMARY KEY, did text NOT NULL, scope text NOT NULL, email boolean DEFAULT true, inapp boolean DEFAULT true
    );
  `);
}, 30000);
afterAll(async () => { await harness.close(); });
beforeEach(async () => {
  await harness.reset();
  await harness.db.update(preferences).set({ inapp: true });
  vi.clearAllMocks();
  mocks.ws.mockResolvedValue(false);
  mocks.phone.mockResolvedValue(undefined);
});

async function seed(options: { remaining?: number; status?: string; capability?: string; capStatus?: string } = {}) {
  const id = `expiry_${++sequence}`;
  await harness.db.insert(delegationGrants).values({
    id, delegatorDid: OWNER, agentDid: 'did:imajin:expiry-agent', audience: { type: 'all' },
    issuedAt: new Date(NOW.getTime() - DAY), expiresAt: new Date(NOW.getTime() + (options.remaining ?? DAY)),
    status: options.status ?? 'active',
  });
  await harness.db.insert(delegationGrantCapabilities).values({
    id: `cap_${id}`, grantId: id, capability: options.capability ?? 'operator:approvals', status: options.capStatus ?? 'active',
  });
  return id;
}

describe('expiring operator grant notifications', () => {
  it('notifies once per grant+expiry, including concurrent sweeps, and notifies again for a new expiry', async () => {
    const id = await seed();
    const sweeps = await Promise.all([notifyExpiringOperatorGrants(NOW), notifyExpiringOperatorGrants(NOW)]);
    expect(sweeps.reduce((sum, result) => sum + result.notified, 0)).toBe(1);
    expect(await notifyExpiringOperatorGrants(NOW)).toEqual({ checked: 1, notified: 0 });
    expect(mocks.ws).toHaveBeenCalledTimes(1);
    expect(mocks.phone).toHaveBeenCalledTimes(1);
    expect(mocks.ws).toHaveBeenCalledWith(OWNER, expect.objectContaining({
      scope: 'delegation.grant.expiring', data: expect.objectContaining({ grantId: id }),
    }));
    await harness.db.update(delegationGrants).set({ expiresAt: new Date(NOW.getTime() + DAY / 2) }).where(eq(delegationGrants.id, id));
    expect(await notifyExpiringOperatorGrants(NOW)).toEqual({ checked: 1, notified: 1 });
    expect(mocks.phone).toHaveBeenCalledTimes(2);
    const rows = await harness.db.select().from(notifications);
    expect(rows.filter(row => (row.data as { grantId: string }).grantId === id)).toHaveLength(2);
  });

  it.each([
    { remaining: DAY + 1 }, { remaining: 0 }, { remaining: -1 }, { status: 'revoked' },
    { capability: 'messages:write' }, { capStatus: 'revoked' },
  ])('does not notify an ineligible grant: %j', async options => {
    await seed(options);
    expect(await notifyExpiringOperatorGrants(NOW)).toEqual({ checked: 0, notified: 0 });
    expect(mocks.ws).not.toHaveBeenCalled();
    expect(mocks.phone).not.toHaveBeenCalled();
  });

  it('retains the durable notification but respects an in-app push opt-out', async () => {
    await seed();
    await harness.db.insert(preferences).values({
      id: 'expiry-pref', did: OWNER, scope: 'delegation.grant.expiring', inapp: false,
    });
    expect(await notifyExpiringOperatorGrants(NOW)).toEqual({ checked: 1, notified: 1 });
    expect(mocks.ws).not.toHaveBeenCalled();
    expect(mocks.phone).not.toHaveBeenCalled();
  });

  it('does not duplicate a durable notice when a transport fails', async () => {
    await seed();
    mocks.ws.mockRejectedValueOnce(new Error('transport unavailable'));
    await expect(notifyExpiringOperatorGrants(NOW)).rejects.toThrow('transport unavailable');
    expect(await notifyExpiringOperatorGrants(NOW)).toEqual({ checked: 1, notified: 0 });
    expect(mocks.ws).toHaveBeenCalledTimes(1);
  });
});
