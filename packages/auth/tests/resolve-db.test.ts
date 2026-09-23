/**
 * Coverage for `createDbResolver`, split into its own `resolve-db.ts` module
 * (and published as the `@imajin/auth/resolve-db` subpath) in #1982 so the
 * `@imajin/auth` root entry never statically drags in `drizzle-orm`.
 *
 * The fake `db` below mimics the shape `createDbResolver` actually calls —
 * `.select().from().where().limit()` — without depending on a real Drizzle
 * table/connection, matching the dependency-injection contract the function
 * was designed around (see the module-level comment in resolve-db.ts).
 */
import { describe, it, expect } from 'vitest';
import { createDbResolver } from '../src/resolve-db';

const identitiesTable = { id: 'id', publicKey: 'publicKey', scope: 'scope', tier: 'tier' };

function fakeDb(rows: unknown[]) {
  return {
    select: (_columns: unknown) => ({
      from: (_table: unknown) => ({
        where: (_condition: unknown) => ({
          limit: (_n: number) => Promise.resolve(rows),
        }),
      }),
    }),
  };
}

describe('createDbResolver', () => {
  it('resolves a matching row into a ResolvedIdentity', async () => {
    const db = fakeDb([{ id: 'did:imajin:abc', publicKey: 'deadbeef', type: 'actor', tier: 'verified' }]);
    const resolver = createDbResolver(db, identitiesTable);

    const result = await resolver('did:imajin:abc');

    expect(result).toEqual({
      did: 'did:imajin:abc',
      publicKey: 'deadbeef',
      type: 'actor',
      tier: 'verified',
    });
  });

  it('returns null when no row matches the DID', async () => {
    const db = fakeDb([]);
    const resolver = createDbResolver(db, identitiesTable);

    const result = await resolver('did:imajin:missing');

    expect(result).toBeNull();
  });

  it('returns null when the query result is nullish', async () => {
    const db = fakeDb(undefined as unknown as unknown[]);
    const resolver = createDbResolver(db, identitiesTable);

    const result = await resolver('did:imajin:missing');

    expect(result).toBeNull();
  });
});
