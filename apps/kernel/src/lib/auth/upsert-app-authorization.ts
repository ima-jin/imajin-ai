import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import { db, attestations } from '@/src/db';
import { isLiveAppAuthorization } from './live-app-authorization';
import { revokeAttestationOnce } from './revoke-attestation';
import { projectAppAuthorizationGrant } from './app-authorization-grant';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Shared by consent and revoke: even an empty pair needs serialization. */
async function lockPair(tx: Transaction, ownerDid: string, appDid: string) {
  const pair = JSON.stringify(['app.authorized', ownerDid, appDid]);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${pair}, 0))`);
}

async function liveGrants(tx: Transaction, ownerDid: string, appDid: string) {
  const rows = await tx.select({
    id: attestations.id, payload: attestations.payload,
    revokedAt: attestations.revokedAt, expiresAt: attestations.expiresAt,
  }).from(attestations).where(and(
    eq(attestations.issuerDid, ownerDid),
    eq(attestations.subjectDid, appDid),
    eq(attestations.type, 'app.authorized'),
    isNull(attestations.revokedAt),
  )).orderBy(desc(attestations.issuedAt), desc(attestations.id));
  const now = Date.now();
  return rows.filter((row) => isLiveAppAuthorization(row, now));
}

function grantScopes(payload: unknown): string[] {
  const scopes = (payload as { scopes?: unknown } | null)?.scopes;
  return Array.isArray(scopes) ? scopes.filter((scope): scope is string => typeof scope === 'string') : [];
}

function sameScopes(a: string[], b: string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every(scope => right.has(scope));
}

interface Consent {
  ownerDid: string;
  appDid: string;
  appId: string;
  callbackUrl: string;
  scopes: string[];
  privateKey: string;
}

async function mintGrant(tx: Transaction, consent: Consent, scopes: string[]) {
  const issuedAt = Date.now();
  const payload = { scopes, appId: consent.appId, callbackUrl: consent.callbackUrl };
  const signature = authCrypto.signSync(canonicalize({
    subject_did: consent.appDid, type: 'app.authorized',
    context_id: consent.appId, context_type: 'app', payload, issued_at: issuedAt,
  }), consent.privateKey);
  const id = `att_${nanoid(16)}`;
  await tx.insert(attestations).values({
    id, issuerDid: consent.ownerDid, subjectDid: consent.appDid,
    type: 'app.authorized', contextId: consent.appId, contextType: 'app',
    payload, signature, issuedAt: new Date(issuedAt),
  });
  return id;
}

/** All grant, signed revocation, refresh-token and app projection writes commit together. */
export function upsertAppAuthorization(consent: Consent): Promise<string> {
  return db.transaction(async tx => {
    await lockPair(tx, consent.ownerDid, consent.appDid);
    const grants = await liveGrants(tx, consent.ownerDid, consent.appDid);
    const scopes = [...new Set(consent.scopes)];
    const newest = grants[0];
    const reuse = newest && sameScopes(grantScopes(newest.payload), scopes);
    const surplus = reuse ? grants.slice(1) : grants;
    for (const grant of surplus) {
      await revokeAttestationOnce({
        attestationId: grant.id, revokedByDid: consent.ownerDid, privateKey: consent.privateKey,
      }, tx);
    }
    const id = reuse ? newest.id : await mintGrant(tx, consent, scopes);
    await projectAppAuthorizationGrant({ ownerDid: consent.ownerDid, appDid: consent.appDid, scopes }, tx);
    return id;
  });
}

/** A surplus revoke must not disconnect the app's surviving grant. */
export function revokeAppAuthorization(params: {
  ownerDid: string; appDid: string; attestationId: string; privateKey: string;
}) {
  return db.transaction(async tx => {
    await lockPair(tx, params.ownerDid, params.appDid);
    const result = await revokeAttestationOnce({
      attestationId: params.attestationId, revokedByDid: params.ownerDid, privateKey: params.privateKey,
    }, tx);
    if (result.revoked) {
      const [survivor] = await liveGrants(tx, params.ownerDid, params.appDid);
      await projectAppAuthorizationGrant({
        ownerDid: params.ownerDid, appDid: params.appDid,
        scopes: survivor ? grantScopes(survivor.payload) : [],
      }, tx);
    }
    return result;
  });
}
