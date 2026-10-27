import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { and, count, eq, gt, sql } from 'drizzle-orm';
import { crypto } from '@imajin/auth';
import { db, attestations, vaultDelegationGrants, type VaultDelegationGrant } from '@/src/db';
import { prepareMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import { _applyDelegationGrant, canonicalizeGrantPayload, vaultService } from './index';
import { getNodeSigningIdentity, getNodeXPrivateKey } from './sealing';
import { lockSshCaPurpose, retireSshCas, sshCaRecords, SshCaError } from './ssh-ca';
import { encodeSshUserCert, parseSshPublicKey } from './ssh-cert-wire';
import { parseSignInput, validSshScope, type SshSignInput } from './ssh-cert-policy';
import type { MintAuthority } from './mint-authority';
import { SSH_CERT_ISSUANCE_LIMIT, SSH_CERT_ISSUANCE_WINDOW_SECONDS } from './ssh-ca-policy';
import { githubGrantee, validGithubGrant, type GithubGrant, type GithubJob } from './github-oidc';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type SshScope = NonNullable<VaultDelegationGrant['sshScope']>;
const denied = () => new SshCaError(403, 'No live matching SSH certificate grant');
const live = (grant: VaultDelegationGrant | undefined, now: number): grant is VaultDelegationGrant =>
  !!grant && grant.status === 'active' && (!grant.expiresAt || grant.expiresAt.getTime() > now)
  && (!grant.oneTime || !grant.consumedAt);

async function audit(tx: Pick<Transaction, 'insert'>, type: 'issued' | 'refused' | 'grant-issued' | 'grant-revoked',
  grantee: string, payload: Record<string, unknown>) {
  await tx.insert(attestations).values(await prepareMechanicalAttestation({
    subjectDid: grantee, type: `vault.ssh-cert.${type}`, contextId: null,
    contextType: 'vault.ssh-cert', payload,
  }));
}

/** Caller holds the purpose and grant locks through issuance/audit commit. */
async function checkIssuanceBudget(tx: Transaction, grantId: string) {
  const [issued] = await tx.select({ total: count() }).from(attestations).where(and(
    eq(attestations.type, 'vault.ssh-cert.issued'),
    eq(sql`${attestations.payload}->>'grantId'`, grantId),
    gt(attestations.issuedAt, new Date(Date.now() - SSH_CERT_ISSUANCE_WINDOW_SECONDS * 1000)),
  ));
  if (issued.total >= SSH_CERT_ISSUANCE_LIMIT) throw new SshCaError(429, 'SSH certificate grant issuance limit exceeded');
}

/** Refusals never persist untrusted request bytes (which might contain a private key). */
export function recordSshRefusal(grantee: string, status: number) {
  return audit(db, 'refused', grantee, { grantee, status });
}
/** Fixed anonymous subject: never attribute unverified claims to a repository. */
export function recordInvalidGithubRefusal() {
  return audit(db, 'refused', getNodeSigningIdentity().senderDid, {
    status: 401, authentication: 'github-oidc', reason: 'invalid-token',
  });
}

/** No separate accumulating replay store: only unexpired issuance history is consulted. */
async function checkGithubReplay(tx: Transaction, job: GithubJob) {
  const lockKey = `vault.ssh-oidc:${job.jtiHash}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  const now = Math.floor(Date.now() / 1000);
  if (!/^[a-f0-9]{64}$/.test(job.jtiHash) || !Number.isSafeInteger(job.expiresAt)
    || job.expiresAt <= now || job.expiresAt > now + 605) throw new SshCaError(401, 'Expired GitHub OIDC token');
  const [used] = await tx.select({ id: attestations.id }).from(attestations).where(and(
    eq(attestations.type, 'vault.ssh-cert.issued'),
    eq(sql`${attestations.payload}->'githubJob'->>'jtiHash'`, job.jtiHash),
    gt(attestations.issuedAt, new Date((now - 605) * 1000)),
    gt(sql`(${attestations.payload}->'githubJob'->>'expiresAt')::bigint`, now),
  )).limit(1);
  if (used) throw new SshCaError(401, 'GitHub OIDC token already used');
}

function checkGithubBinding(scope: SshScope, job: GithubJob) {
  const binding = scope.github;
  if (!binding) throw new SshCaError(403, 'GitHub grant missing repository ids; operator must re-grant');
  if (!validGithubGrant(binding) || binding.repository !== job.repository || binding.environment !== job.environment
    || binding.repositoryId !== job.repositoryId || binding.repositoryOwnerId !== job.repositoryOwnerId
    || (binding.allowedRefs && !binding.allowedRefs.includes(job.workflow))) throw denied();
}

export function issueSshGrant(purpose: string, grantee: string, scope: SshScope, expiresAt: Date,
  authority: MintAuthority, github?: GithubGrant) {
  if (github && (!validGithubGrant(github) || githubGrantee(github.repository, github.environment) !== grantee)) {
    throw new SshCaError(400, 'GitHub grants require repository ids and valid allowed refs');
  }
  if (!github && (grantee.startsWith('did:github:') || scope.github)) throw denied();
  scope = { ...scope, ...(github ? { github } : {}) };
  if (!validSshScope(scope) || !/^did:[a-z0-9]+:[a-zA-Z0-9._:-]{1,200}$/.test(grantee)
    || !Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new SshCaError(400, 'Invalid SSH grant policy');
  }
  return db.transaction(async tx => {
    await lockSshCaPurpose(tx, purpose);
    const rows = await sshCaRecords(tx, purpose);
    await retireSshCas(tx, rows, purpose, new Date());
    const ca = rows.find(row => row.id === scope.caId && row.status === 'active');
    if (!ca) throw denied();
    const node = getNodeSigningIdentity();
    if (grantee === node.senderDid) throw new SshCaError(400, 'SSH operation grantee must differ from custody identity');
    const raw = {
      subject: node.senderDid, grantedTo: grantee, field: ca.field, keyId: ca.id,
      ownerXPub: '', wrappedKey: '', wrappedNonce: '', expiresAt, sshScope: scope,
    };
    const grantId = `vdg_${randomUUID()}`;
    await tx.insert(vaultDelegationGrants).values({
      id: grantId, ...raw, ownerSignature: crypto.signSync(canonicalizeGrantPayload(raw), node.privateKeyHex),
      ownerEdPub: node.senderPubkey, purpose: `ssh-cert:${purpose}`, status: 'active',
    });
    await audit(tx, 'grant-issued', grantee, {
      grantId, purpose, grantee, ...(github ? { github } : {}), ...scope, expiresAt: expiresAt.toISOString(), actor: authority.actingDid,
      composedBy: authority.composedBy,
    });
    return { grantId, purpose, grantee, ...(github ? { github } : {}), ...scope, expiresAt: expiresAt.toISOString() };
  });
}

export function revokeSshGrant(purpose: string, grantId: string, authority: MintAuthority) {
  return db.transaction(async tx => {
    await lockSshCaPurpose(tx, purpose);
    await retireSshCas(tx, await sshCaRecords(tx, purpose), purpose, new Date());
    const [grant] = await tx.select().from(vaultDelegationGrants)
      .where(eq(vaultDelegationGrants.id, grantId)).for('update');
    if (!grant?.sshScope || grant.purpose !== `ssh-cert:${purpose}`) throw new SshCaError(404, 'SSH grant not found');
    if (grant.status !== 'active') return { grantId, alreadyRevoked: true };
    await tx.update(vaultDelegationGrants).set({ status: 'revoked', revokedAt: new Date() })
      .where(eq(vaultDelegationGrants.id, grantId));
    await audit(tx, 'grant-revoked', grant.grantedTo, {
      grantId, purpose, caId: grant.sshScope.caId, actor: authority.actingDid, composedBy: authority.composedBy,
    });
    return { grantId, alreadyRevoked: false };
  });
}

/** A row lock also serializes generic vault revocation; no cached signer or policy. */
export function signSshCert(input: SshSignInput, grantee: string, githubJob?: GithubJob) {
  input = parseSignInput(input);
  if (grantee.startsWith('did:github:')
    && (!githubJob || githubGrantee(githubJob.repository, githubJob.environment) !== grantee)) throw denied();
  return db.transaction(async tx => {
    if (githubJob) await checkGithubReplay(tx, githubJob);
    await lockSshCaPurpose(tx, input.purpose);
    const rows = await sshCaRecords(tx, input.purpose);
    await retireSshCas(tx, rows, input.purpose, new Date());
    const ca = rows.find(row => row.id === input.caId && row.status === 'active');
    if (!ca || rows.filter(row => row.status === 'active').length !== 1) throw denied();
    const [grant] = await tx.select().from(vaultDelegationGrants)
      .where(eq(vaultDelegationGrants.id, input.grantId)).for('update');
    const node = getNodeSigningIdentity();
    const now = Math.floor(Date.now() / 1000);
    if (!live(grant, Date.now()) || grant.grantedTo !== grantee || grant.subject !== node.senderDid
      || grant.field !== ca.field || grant.keyId !== ca.id || grant.sshScope?.caId !== ca.id
      || !validSshScope(grant.sshScope)
      || !grant.sshScope.principals.includes(input.principal) || !grant.sshScope.allowedHosts.includes(input.host)
      || !crypto.verifySync(grant.ownerSignature, canonicalizeGrantPayload(grant), node.senderPubkey)) throw denied();
    if (githubJob) checkGithubBinding(grant.sshScope, githubJob);
    else if (grant.sshScope.github) throw denied();
    await checkIssuanceBudget(tx, grant.id);
    const principal = grant.sshScope.principals.find(value => value === input.principal)!;
    const [custody] = await tx.select().from(vaultDelegationGrants)
      .where(and(eq(vaultDelegationGrants.id, ca.grantId ?? ''), eq(vaultDelegationGrants.field, ca.field))).for('update');
    if (!live(custody, Date.now()) || custody.grantedTo !== node.senderDid || custody.subject !== ca.did
      || custody.sshScope || custody.oneTime) throw denied();
    const entry = await vaultService.get(ca.field);
    if (!entry || entry.deleted || entry.custodyScheme !== 'delegation-grant'
      || entry.senderPubkey !== node.senderPubkey) throw denied();
    const validBefore = Math.min(now + input.ttl,
      Math.floor((grant.expiresAt?.getTime() ?? Infinity) / 1000),
      Math.floor((custody.expiresAt?.getTime() ?? Infinity) / 1000));
    if (validBefore <= now) throw denied();
    const serial = randomBytes(8).readBigUInt64BE().toString();
    const keyId = `ssh-cert:${randomUUID()}`;
    const seed = await _applyDelegationGrant(entry, custody, getNodeXPrivateKey(), node.senderPubkey);
    if (validBefore <= Math.floor(Date.now() / 1000)
      || (githubJob && githubJob.expiresAt <= Math.floor(Date.now() / 1000))) throw denied();
    const certificate = encodeSshUserCert({
      publicKey: parseSshPublicKey(input.publicKey)!, caPublicKey: ca.publicKey, caSeed: seed,
      principal, forceCommand: grant.sshScope.forceCommand, serial, keyId,
      validAfter: now, validBefore,
    });
    // No result escapes until its signed event and any one-time consumption commit.
    if (grant.oneTime) await tx.update(vaultDelegationGrants).set({ consumedAt: new Date() })
      .where(eq(vaultDelegationGrants.id, grant.id));
    const payload = {
      job: input.job, ...(githubJob ? { githubJob } : {}), grantee, principal, host: input.host, ttl: validBefore - now,
      serial, keyId, caId: ca.id, grantId: grant.id, purpose: input.purpose, validAfter: now, validBefore,
      publicKeyFingerprint: `SHA256:${createHash('sha256').update(Buffer.from(input.publicKey.split(' ')[1], 'base64'))
        .digest('base64').replaceAll('=', '')}`,
    };
    await audit(tx, 'issued', grantee, payload);
    return { certificate, ...payload };
  });
}
