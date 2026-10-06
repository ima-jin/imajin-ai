import { describe, it, expect } from 'vitest';
import {
  AGENT_APPROVAL_REQUIRED,
  DELEGATION_ROUTES,
  enforceDelegationPolicy,
  enforceRoutePolicy,
  evaluateDelegationPolicy,
  requiresOwnerCountersign,
  type DelegationRouteKey,
  type MutationClass,
} from '../src/delegation-policy';

const OWNER = 'did:imajin:owner';
const AGENT = 'did:imajin:agent';

/** A session under `X-Acting-For`: the agent's own identity acting for OWNER. */
const delegate = { id: AGENT, actingFor: OWNER };
/** The owner on their own session, no delegation overlay. */
const owner = { id: OWNER };

const CLASSES: MutationClass[] = ['reversible', 'irreversible', 'value-moving'];

function keyOfClass(cls: MutationClass): DelegationRouteKey {
  const entry = Object.entries(DELEGATION_ROUTES).find(([, e]) => e.class === cls);
  if (!entry) throw new Error(`no registered route of class ${cls}`);
  return entry[0] as DelegationRouteKey;
}

describe('requiresOwnerCountersign', () => {
  it('requires countersign for irreversible and value-moving only', () => {
    expect(requiresOwnerCountersign('reversible')).toBe(false);
    expect(requiresOwnerCountersign('irreversible')).toBe(true);
    expect(requiresOwnerCountersign('value-moving')).toBe(true);
  });
});

describe('reversible class — a delegate may execute', () => {
  it('lets a delegate through', () => {
    expect(enforceDelegationPolicy(delegate, { action: 'rename', class: 'reversible' })).toBeNull();
  });

  it('lets the owner through', () => {
    expect(enforceDelegationPolicy(owner, { action: 'rename', class: 'reversible' })).toBeNull();
  });
});

describe.each(['irreversible', 'value-moving'] as const)('%s class — a delegate may propose, never execute', (cls) => {
  it('refuses a delegate with 403 AGENT_APPROVAL_REQUIRED and names the owner', async () => {
    const res = enforceDelegationPolicy(delegate, { action: 'do-it', class: cls, resourceId: 'res_1' });

    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    expect(await res!.json()).toEqual({
      error: `Agent delegation does not permit ${cls} operations — the owner must countersign`,
      code: AGENT_APPROVAL_REQUIRED,
      action: 'do-it',
      class: cls,
      resourceId: 'res_1',
      ownerDid: OWNER,
      delegateDid: AGENT,
    });
  });

  it('lets the owner countersign on their own session', () => {
    expect(enforceDelegationPolicy(owner, { action: 'do-it', class: cls })).toBeNull();
  });

  it('treats a self-delegation (actingFor === id) as the owner, not a delegate', () => {
    expect(enforceDelegationPolicy({ id: OWNER, actingFor: OWNER }, { action: 'do-it', class: cls })).toBeNull();
  });

  it('passes when there is no delegation overlay at all (e.g. scoped app-token path)', () => {
    expect(enforceDelegationPolicy(null, { action: 'do-it', class: cls })).toBeNull();
    expect(enforceDelegationPolicy(undefined, { action: 'do-it', class: cls })).toBeNull();
  });

  it('refuses a delegate arriving as a resolveEffectiveDid result (composedBy set)', () => {
    const decision = evaluateDelegationPolicy({ effectiveDid: OWNER, composedBy: AGENT }, { action: 'pay', class: cls });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.body.ownerDid).toBe(OWNER);
      expect(decision.body.delegateDid).toBe(AGENT);
    }
  });

  it('lets a resolveEffectiveDid result through when nobody composed it (owner or app path)', () => {
    expect(evaluateDelegationPolicy({ effectiveDid: OWNER, composedBy: null }, { action: 'pay', class: cls })).toEqual({ allowed: true });
    expect(evaluateDelegationPolicy({ effectiveDid: OWNER, composedBy: OWNER }, { action: 'pay', class: cls })).toEqual({ allowed: true });
  });

  it('omits resourceId from the body when the route has none', async () => {
    const res = enforceDelegationPolicy(delegate, { action: 'do-it', class: cls });
    expect(await res!.json()).not.toHaveProperty('resourceId');
  });

  it('applies caller headers and merges extra fields without letting them override policy fields', async () => {
    const res = enforceDelegationPolicy(
      delegate,
      { action: 'do-it', class: cls, resourceId: 'res_1' },
      { headers: { 'x-test': '1' }, extra: { assetId: 'res_1', code: 'SPOOFED' } },
    );
    expect(res!.headers.get('x-test')).toBe('1');
    const body = await res!.json();
    expect(body.assetId).toBe('res_1');
    expect(body.code).toBe(AGENT_APPROVAL_REQUIRED);
  });
});

describe('enforceRoutePolicy — registry lookup', () => {
  it.each(CLASSES)('applies the registered class for a %s route', async (cls) => {
    const key = keyOfClass(cls);
    const res = enforceRoutePolicy(delegate, key, { resourceId: 'res_1' });

    if (cls === 'reversible') {
      expect(res).toBeNull();
      return;
    }
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.class).toBe(cls);
    expect(body.action).toBe(DELEGATION_ROUTES[key].action);
    expect(enforceRoutePolicy(owner, key)).toBeNull();
  });

  it('classifies the headline routes from #2360 as ruled', () => {
    expect(DELEGATION_ROUTES['media.asset.transfer'].class).toBe('value-moving');
    expect(DELEGATION_ROUTES['media.asset.settle'].class).toBe('value-moving');
    expect(DELEGATION_ROUTES['media.asset.delete'].class).toBe('irreversible');
    expect(DELEGATION_ROUTES['media.asset.upgrade-fair'].class).toBe('irreversible');
    expect(DELEGATION_ROUTES['media.asset.rename'].class).toBe('reversible');
  });
});

describe('DELEGATION_ROUTES registry integrity', () => {
  const entries = Object.entries(DELEGATION_ROUTES);

  it('has an entry for each class', () => {
    for (const cls of CLASSES) {
      expect(entries.some(([, e]) => e.class === cls)).toBe(true);
    }
  });

  it.each(entries)('%s is well-formed and namespaced by its app', (key, entry) => {
    expect(CLASSES).toContain(entry.class);
    expect(['POST', 'PUT', 'PATCH', 'DELETE']).toContain(entry.method);
    expect(entry.path.startsWith('/')).toBe(true);
    expect(entry.action).toBe(key.split('.').at(-1));
    expect(entry.why.length).toBeGreaterThan(0);
    // The key's first segment names the owning app, except the media/pay
    // sub-services that live in the kernel app.
    const domain = key.split('.')[0];
    expect([entry.app, 'media', 'pay']).toContain(domain);
  });

  it('has no duplicate (app, method, path) — one key per route handler', () => {
    const seen = new Set<string>();
    for (const [, e] of entries) {
      const id = `${e.app} ${e.method} ${e.path}`;
      expect(seen.has(id)).toBe(false);
      seen.add(id);
    }
  });
});
