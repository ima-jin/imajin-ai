/**
 * DB-backed public key resolver for `@imajin/auth`.
 *
 * This is the ONLY module in `@imajin/auth` that references `drizzle-orm`
 * (dynamically, and only to construct an `eq()` condition against a
 * *caller*-supplied Drizzle table/db — see `createDbResolver` below; it
 * never imports `@imajin/db` or connects to anything itself, so it does not
 * violate the #1992 "auth never reaches the database directly" guard, see
 * `tests/no-db-access-guard.test.ts`).
 *
 * It is published as its own `@imajin/auth/resolve-db` subpath, separate
 * from the package root, so that `import { requireAuth } from '@imajin/auth'`
 * (or anything else from the root) never drags a static `drizzle-orm`
 * import into the bundle. Without this split, a Next.js app that installs
 * `@imajin/auth` but not `drizzle-orm` fails to build with "Module not
 * found: Can't resolve 'drizzle-orm'" — webpack statically resolves every
 * `import()` it can see in a loaded chunk, even a dynamic one that's never
 * actually executed by that consumer (see #1982's pack-and-install proof).
 *
 * Only import from here if the caller already has `drizzle-orm` installed
 * and a Drizzle `identities`-shaped table to pass in (see `apps/kernel`'s
 * `settle-core.ts` / `witness-jws.ts` / `operator-countersign.ts` for the
 * in-repo usage pattern).
 */
import type { PublicKeyResolver, ResolvedIdentity } from './resolve';

/**
 * Minimal shape of the caller-supplied Drizzle `db` this function actually
 * calls (`.select().from().where().limit()`). Typed as a narrow callable
 * chain — not `Function` — so this stays dependency-injected without
 * coupling to any specific app's full Drizzle instance type.
 */
interface DbSelectChain {
  select: (columns: Record<string, unknown>) => {
    from: (table: unknown) => {
      where: (condition: unknown) => {
        limit: (n: number) => Promise<unknown[]>;
      };
    };
  };
}

/** Shape of a raw row as selected below — note `id`, not `did` (see the mapping at the bottom of `createDbResolver`). */
interface IdentityRow {
  id: string;
  publicKey: string;
  type: string;
  tier: string;
}

/**
 * Create a DB-backed resolver.
 * Accepts a db instance and the identities table (to avoid hard coupling to the app).
 */
export function createDbResolver(
  db: DbSelectChain,
  identitiesTable: unknown
): PublicKeyResolver {
  return async (did: string): Promise<ResolvedIdentity | null> => {
    const { eq } = await import('drizzle-orm');
    const table = identitiesTable as any;

    // `identities` has no `type` column — the closest analogue is `scope`
    // ('actor' | 'family' | 'community' | 'business'), which is what the HTTP
    // resolver (registry/api/identity/:did) maps into ResolvedIdentity.type.
    // Selecting a column that doesn't exist on the table resolves to
    // `undefined`, which crashes drizzle's `orderSelectedFields` during query
    // preparation (`Object.entries(undefined)`) — see #1709.
    const rows = (await db
      .select({
        id: table.id,
        publicKey: table.publicKey,
        type: table.scope,
        tier: table.tier,
      })
      .from(table)
      .where(eq(table.id, did))
      .limit(1)) as IdentityRow[];

    if (!rows || rows.length === 0) return null;

    return {
      did: rows[0].id,
      publicKey: rows[0].publicKey,
      type: rows[0].type,
      tier: rows[0].tier,
    };
  };
}
