import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernelDeps } from '../lib/provision-service-bootstrap.ts';

const { query } = vi.hoisted(() => ({ query: vi.fn(async () => []) }));

// No Drizzle table/schema is exposed: registration must not enumerate it.
vi.mock('../../apps/kernel/src/db/index.ts', () => ({ getClient: () => query }));

afterEach(() => {
  vi.clearAllMocks();
});

describe('bootstrap identity insert (#2960)', () => {
  it('names exactly the six written columns, never unused nullable schema columns', async () => {
    const identity = {
      did: 'did:imajin:bootstrap',
      publicKey: 'public-key',
      name: "service's vault bootstrap",
    };

    await createKernelDeps('operator:test').registerIdentity(identity);

    expect(query).toHaveBeenCalledTimes(1);
    const [strings, ...values] = query.mock.calls[0];
    expect(strings.join('?').replace(/\s+/g, ' ').trim()).toBe(
      'INSERT INTO auth.identities (id, scope, subtype, public_key, name, tier) ' +
      "VALUES (?, 'actor', 'service', ?, ?, 'preliminary') ON CONFLICT DO NOTHING",
    );
    expect(values).toEqual([identity.did, identity.publicKey, identity.name]);
  });

  it('keeps user-provided values parameterized, including SQL-looking names', async () => {
    const name = "bootstrap'); DROP TABLE auth.identities; --";
    await createKernelDeps('operator:test').registerIdentity({
      did: 'did:imajin:bootstrap',
      publicKey: 'public-key',
      name,
    });

    const [strings, ...values] = query.mock.calls[0];
    expect(strings.join('')).not.toContain(name);
    expect(values).toEqual(['did:imajin:bootstrap', 'public-key', name]);
  });

  it('propagates insert failures so provisioning cannot continue to a restart', async () => {
    query.mockRejectedValueOnce(new Error('insert failed'));

    await expect(createKernelDeps('operator:test').registerIdentity({
      did: 'did:imajin:bootstrap',
      publicKey: 'public-key',
      name: 'service vault bootstrap',
    })).rejects.toThrow('insert failed');
  });
});
