import { describe, it, expect } from 'vitest';
import {
  resolveOrMintIdentity,
  isResolveIdentityError,
  type IdentityAliasRepo,
  type ResolveIdentityResult,
} from '../identity-alias';

/**
 * In-memory {@link IdentityAliasRepo} modeling the unique `(namespace, ref)`
 * constraint. `claimAlias` is atomic (no internal await), so concurrent
 * first-references collapse to a single winner exactly like the DB
 * ON CONFLICT DO NOTHING path.
 */
class InMemoryRepo implements IdentityAliasRepo {
  readonly aliases = new Map<string, string>();
  readonly identities = new Map<string, Record<string, unknown>>();
  private seq = 0;

  private static key(namespace: string, ref: string): string {
    return `${namespace}\u0000${ref}`;
  }

  async findAlias(namespace: string, ref: string): Promise<string | null> {
    return this.aliases.get(InMemoryRepo.key(namespace, ref)) ?? null;
  }

  async claimAlias(namespace: string, ref: string, did: string): Promise<boolean> {
    const key = InMemoryRepo.key(namespace, ref);
    if (this.aliases.has(key)) return false;
    this.aliases.set(key, did);
    return true;
  }

  async createIdentity(did: string, _type: string, metadata: Record<string, unknown>): Promise<Record<string, unknown>> {
    const stored = { ...metadata };
    this.identities.set(did, stored);
    return stored;
  }

  async getIdentityMetadata(did: string): Promise<Record<string, unknown> | null> {
    return this.identities.get(did) ?? null;
  }

  async mergeMetadata(did: string, incoming: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const current = this.identities.get(did) ?? {};
    const merged = { ...current, ...incoming };
    this.identities.set(did, merged);
    return merged;
  }

  mintDid(): string {
    this.seq += 1;
    return `did:imajin:test${this.seq}`;
  }
}

function ok(result: ResolveIdentityResult | { error: string; status: number }): ResolveIdentityResult {
  if (isResolveIdentityError(result)) {
    throw new Error(`Expected success, got error: ${result.error}`);
  }
  return result;
}

describe('resolveOrMintIdentity', () => {
  it('mints once and returns the same DID on re-reference (created true then false)', async () => {
    const repo = new InMemoryRepo();
    const input = { namespace: 'tripian', ref: 'restaurant:kai', type: 'restaurant', metadata: {} };

    const first = ok(await resolveOrMintIdentity(repo, input));
    const second = ok(await resolveOrMintIdentity(repo, input));

    expect(first.created).toBe(true);
    expect(first.minted).toBe(true);
    expect(first.did).toMatch(/^did:imajin:/);
    expect(second.created).toBe(false);
    expect(second.minted).toBe(false);
    expect(second.did).toBe(first.did);
  });

  it('collapses concurrent first-references to a single DID', async () => {
    const repo = new InMemoryRepo();
    const input = { namespace: 'tripian', ref: 'restaurant:kai', type: 'restaurant', metadata: {} };

    const [a, b] = await Promise.all([
      resolveOrMintIdentity(repo, input),
      resolveOrMintIdentity(repo, input),
    ]).then((results) => results.map(ok));

    expect(a.did).toBe(b.did);
    // Exactly one call minted; the other reused it.
    expect([a.minted, b.minted].filter(Boolean)).toHaveLength(1);
    expect(repo.aliases.size).toBe(1);
    expect(repo.identities.size).toBe(1);
  });

  it('merges re-reference metadata additively without dropping prior keys', async () => {
    const repo = new InMemoryRepo();
    const base = { namespace: 'tripian', ref: 'restaurant:kai', type: 'restaurant' };

    const first = ok(await resolveOrMintIdentity(repo, { ...base, metadata: { cuisine: 'hawaiian' } }));
    const second = ok(await resolveOrMintIdentity(repo, { ...base, metadata: { location: 'honolulu' } }));

    expect(second.did).toBe(first.did);
    expect(second.metadata).toMatchObject({
      cuisine: 'hawaiian',
      location: 'honolulu',
      type: 'restaurant',
      aliasNamespace: 'tripian',
    });
  });

  it('resolves the same ref in different namespaces to different DIDs', async () => {
    const repo = new InMemoryRepo();

    const tripian = ok(await resolveOrMintIdentity(repo, {
      namespace: 'tripian', ref: 'restaurant:kai', type: 'restaurant', metadata: {},
    }));
    const other = ok(await resolveOrMintIdentity(repo, {
      namespace: 'other', ref: 'restaurant:kai', type: 'restaurant', metadata: {},
    }));

    expect(tripian.did).not.toBe(other.did);
    expect(tripian.created).toBe(true);
    expect(other.created).toBe(true);
  });

  it('fails closed when an alias points to a missing identity', async () => {
    const repo = new InMemoryRepo();
    // Seed a dangling alias with no backing identity.
    await repo.claimAlias('tripian', 'ghost', 'did:imajin:missing');

    const result = await resolveOrMintIdentity(repo, {
      namespace: 'tripian', ref: 'ghost', type: 'restaurant', metadata: {},
    });

    expect(isResolveIdentityError(result)).toBe(true);
  });
});
