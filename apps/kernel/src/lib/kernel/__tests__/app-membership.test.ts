import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  profiles: { did: 'profile.did', featureToggles: 'profile.featureToggles' },
  identities: { id: 'identity.id', name: 'identity.name' },
  forestConfig: { groupDid: 'forest.did', enabledServices: 'forest.services', landingService: 'forest.landing' },
  identityMembers: { identityDid: 'membership.group', memberDid: 'membership.member', removedAt: 'membership.removed', role: 'membership.role' },
  profile: undefined as { featureToggles: Record<string, unknown> } | undefined,
  forest: undefined as { enabledServices: string[]; landingService: string | null } | undefined,
  membership: undefined as { role: string } | undefined,
  name: 'Person' as string | null,
  writes: [] as Array<{ table: unknown; values: Record<string, unknown>; conflict: Record<string, unknown> }>,
  execute: vi.fn(),
  rowLock: vi.fn(),
}));

vi.mock('@/src/db', () => {
  function selectRows(table: unknown) {
    const rows = table === h.profiles ? (h.profile ? [h.profile] : [])
      : table === h.forestConfig ? (h.forest ? [h.forest] : [])
        : table === h.identityMembers ? (h.membership ? [h.membership] : [])
          : [{ name: h.name }];
    const promise = Promise.resolve(rows);
    return Object.assign(promise, { for: (lock: string) => { h.rowLock(lock); return promise; } });
  }
  const from = (table: unknown) => ({ where: () => ({ limit: () => selectRows(table) }) });
  const select = () => ({ from });
  const tx = {
    select,
    execute: h.execute,
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoUpdate: async (conflict: Record<string, unknown>) => {
          h.writes.push({ table, values, conflict });
          if (table === h.profiles) h.profile = { featureToggles: values.featureToggles as Record<string, unknown> };
        },
      }),
    }),
  };
  // Model the transaction lock's serialization, including missing-row creation.
  let pending = Promise.resolve();
  return {
    ...h,
    db: {
      select,
      transaction: (fn: (connection: typeof tx) => Promise<void>) => {
        const next = pending.then(() => fn(tx));
        pending = next;
        return next;
      },
    },
  };
});

import { addConsentedApp, canManageGroupApps, setGroupAppMembership, setPersonAppMembership, updateAppSlugs } from '../app-membership';

beforeEach(() => {
  vi.clearAllMocks();
  h.profile = undefined;
  h.forest = undefined;
  h.membership = undefined;
  h.name = 'Person';
  h.writes = [];
});

describe('person app membership', () => {
  it('creates a missing profile with no defaults', async () => {
    await setPersonAppMembership('person', 'coffee', true);
    expect(h.writes[0].values).toEqual({ did: 'person', displayName: 'Person', featureToggles: { enabledApps: ['coffee'] } });
    expect(h.execute).toHaveBeenCalledOnce();
    expect(h.rowLock).toHaveBeenCalledWith('update');
  });
  it('uses DID as a display fallback without a name', async () => {
    h.name = null;
    await setPersonAppMembership('person', 'coffee', false);
    expect(h.writes[0].values).toMatchObject({ displayName: 'person', featureToggles: { enabledApps: [] } });
  });
  it('materializes legacy membership once and never resurrects removed apps', async () => {
    h.profile = { featureToggles: { coffee: 'old', learn: 'old', inference_enabled: true } };
    await setPersonAppMembership('person', 'coffee', false);
    await setPersonAppMembership('person', 'links', true);
    expect(h.profile?.featureToggles).toEqual({
      coffee: 'old', learn: 'old', inference_enabled: true, enabledApps: ['learn', 'links'],
    });
  });
  it('preserves explicit membership and unrelated toggles', async () => {
    h.profile = { featureToggles: { coffee: 'old', enabledApps: [], show_events: true } };
    await setPersonAppMembership('person', 'learn', true);
    expect(h.profile?.featureToggles).toMatchObject({ enabledApps: ['learn'], show_events: true });
    // Conflict update merges only enabledApps into the current JSONB row.
    expect(h.writes[0].conflict).toHaveProperty('set.featureToggles');
  });
  it('retains concurrent additions and consent appends idempotently', async () => {
    await Promise.all([addConsentedApp('person', 'coffee'), addConsentedApp('person', 'learn')]);
    await addConsentedApp('person', 'coffee');
    expect(h.profile?.featureToggles.enabledApps).toEqual(['coffee', 'learn']);
  });
  it('ignores consent for registry apps without a slug', async () => {
    await addConsentedApp('person', null);
    expect(h.writes).toEqual([]);
  });
  it('deduplicates additions and ignores removal of an absent slug', () => {
    expect(updateAppSlugs(['a', 'a'], 'a', true)).toEqual(['a']);
    expect(updateAppSlugs(['a'], 'b', false)).toEqual(['a']);
  });
});

describe('explicit group app membership', () => {
  it('preserves kernel services and creates missing configs without defaults', async () => {
    await setGroupAppMembership('group', 'coffee', true);
    expect(h.writes[0].values).toMatchObject({ enabledServices: ['coffee'] });
    h.forest = { enabledServices: ['pay', 'media', 'coffee'], landingService: 'pay' };
    await setGroupAppMembership('group', 'learn', true);
    expect(h.writes[1].values).toMatchObject({ enabledServices: ['pay', 'media', 'coffee', 'learn'], landingService: 'pay' });
  });
  it('clears the landing service only when removing that app', async () => {
    h.forest = { enabledServices: ['pay', 'coffee'], landingService: 'coffee' };
    await setGroupAppMembership('group', 'coffee', false);
    expect(h.writes[0].values).toMatchObject({ enabledServices: ['pay'], landingService: null });
  });
  it.each(['owner', 'admin'])('allows active %s controllers', async (role) => {
    h.membership = { role };
    expect(await canManageGroupApps('group', 'person')).toBe(true);
  });
  it.each(['member', 'unknown', undefined])('denies insufficient role %s', async (role) => {
    h.membership = role ? { role } : undefined;
    expect(await canManageGroupApps('group', 'person')).toBe(false);
  });
});
