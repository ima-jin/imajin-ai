/**
 * `usage.emitters` registry access (#1151).
 *
 * The registry is what `POST /usage/api/incurred` checks a `source` against
 * before accepting rows for it, and what `GET`/`PUT /usage/api/emitters`
 * reads and writes. Kept as its own module — no request/response, no
 * `NextRequest` — so both routes (and their tests) share one source of
 * truth for the shape of a registered emitter, mirroring the
 * `connector-registry-store.ts` / route split used for `kernel.connectors`.
 */
import { eq } from 'drizzle-orm';
import { db, usageEmitters, type UsageEmitter } from '@/src/db';

/** Fields a caller may set when registering (or updating) an emitter. */
export interface EmitterRegistration {
  source: string;
  reader: string;
  issuerDid: string;
  actingFor?: string | null;
  keyField?: string | null;
  cadence?: string | null;
  config?: Record<string, unknown>;
  status?: 'active' | 'revoked';
}

/** Look up one emitter by its `usage.incurred.source` value. */
export async function getEmitter(source: string): Promise<UsageEmitter | undefined> {
  const rows = await db.select().from(usageEmitters).where(eq(usageEmitters.source, source)).limit(1);
  return rows[0];
}

/**
 * Every emitter registered by `issuerDid`, newest first — the `GET
 * /usage/api/emitters` read. Owner-scoped: a caller only ever sees their own
 * registrations, never the full registry.
 */
export async function listEmittersForIssuer(issuerDid: string): Promise<UsageEmitter[]> {
  return db
    .select()
    .from(usageEmitters)
    .where(eq(usageEmitters.issuerDid, issuerDid))
    .orderBy(usageEmitters.createdAt);
}

/**
 * Register or update an emitter. Upserts on `source` (the primary key), so
 * re-registering the same source refreshes its row rather than erroring.
 *
 * Callers (the `PUT /usage/api/emitters` route) are responsible for forcing
 * `issuerDid` to the authenticated caller's own effective DID before calling
 * this — this module does not itself enforce ownership, matching the
 * `connector-registry-store.ts` precedent of keeping auth in the route.
 */
export async function upsertEmitter(reg: EmitterRegistration): Promise<UsageEmitter> {
  const now = new Date();
  const [row] = await db
    .insert(usageEmitters)
    .values({
      source: reg.source,
      reader: reg.reader,
      issuerDid: reg.issuerDid,
      actingFor: reg.actingFor ?? null,
      keyField: reg.keyField ?? null,
      cadence: reg.cadence ?? null,
      config: reg.config ?? {},
      status: reg.status ?? 'active',
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: usageEmitters.source,
      set: {
        reader: reg.reader,
        issuerDid: reg.issuerDid,
        actingFor: reg.actingFor ?? null,
        keyField: reg.keyField ?? null,
        cadence: reg.cadence ?? null,
        config: reg.config ?? {},
        status: reg.status ?? 'active',
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

/**
 * True when `callerDid` is allowed to emit rows for this emitter: either the
 * DID that registered it, or the DID it reports spend on behalf of (#1151's
 * "issuer_did (or actingFor chain)" rule).
 */
export function callerMatchesEmitter(emitter: Pick<UsageEmitter, 'issuerDid' | 'actingFor'>, callerDid: string): boolean {
  return callerDid === emitter.issuerDid || (emitter.actingFor !== null && callerDid === emitter.actingFor);
}

/** Convenience guard used by the ingest route before it trusts a `source`. */
export function isActiveEmitter(emitter: Pick<UsageEmitter, 'status'> | undefined): emitter is UsageEmitter {
  return Boolean(emitter) && emitter!.status === 'active';
}
