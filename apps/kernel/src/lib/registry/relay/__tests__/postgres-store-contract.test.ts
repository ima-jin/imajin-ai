import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { OperationCommit, StoredRevocation } from '@metalabel/dfos-web-relay';
import { PostgresRelayStore } from '../postgres-store';
import { createIdentityChain, createSigner, verifyChain } from '@imajin/dfos';
import { bytesToHex } from '@imajin/auth';
import { createNewEd25519Keypair, dagCborCanonicalEncode } from '@metalabel/dfos-protocol/crypto';
import { signContentOperation, verifyContentChain, verifyContentDag } from '@metalabel/dfos-protocol/chain';
import { createDFOSCredential, decodeDFOSCredentialUnsafe } from '@metalabel/dfos-protocol/credentials';
import { createAsOfKeyResolver, createIdentityResolver, createHttpPeerClient, createRelay } from '@metalabel/dfos-web-relay';
import { createCustomRelay } from '../create-relay';

vi.setConfig({ hookTimeout: 30_000 });
let database: PGlite;
let store: PostgresRelayStore;
const timestamp = '2026-01-01T00:00:00.000Z';
const migration = readFileSync(resolve('migrations/0236_relay_055_store_contract.sql'), 'utf8');
const tables = ['relay_operations', 'relay_identity_chains', 'relay_content_chains', 'relay_blobs',
  'relay_countersignatures', 'relay_operation_log', 'relay_pending_operations', 'relay_peer_cursors',
  'relay_revocations', 'relay_public_credentials'];

function operation(cid: string): OperationCommit {
  return {
    kind: 'operation',
    operation: { cid, jwsToken: 'test-operation', chainType: 'artifact', chainId: 'issuer' },
    logEntry: { cid, jwsToken: 'test-operation', kind: 'artifact', chainId: 'issuer', ingestedAt: timestamp },
  };
}

function revocation(cid: string, issuerDID = 'issuer', credentialCID = 'credential', createdAt = timestamp): StoredRevocation {
  return { cid, issuerDID, credentialCID, createdAt, jwsToken: `signed-${cid}` };
}

beforeAll(async () => {
  database = new PGlite();
  // Use the actual baseline's relay DDL, not a second schema that could drift.
  const baseline = readFileSync(resolve('migrations/0001_kernel_baseline.sql'), 'utf8');
  const statements = baseline.replaceAll(/^--.*$/gm, '').split(';').filter((statement) =>
    /^\s*(?:CREATE|ALTER)[^\n]*\brelay(?:\.|\s*$)/.test(statement));
  await database.exec(statements.join(';') + ';');
  await database.exec(migration);
  store = new PostgresRelayStore(drizzle(database) as never);
});
afterAll(async () => { await database.close(); });
beforeEach(async () => {
  await database.exec(`TRUNCATE ${tables.map((table) => `relay.${table}`).join(', ')}`);
});

describe('relay 0.55 SQL store contract', () => {
  it('boots the kernel factory with durable writes and serves proof-plane reads', async () => {
    const relay = await createCustomRelay({ store, content: true });
    expect(await store.getIdentityChain(relay.did)).toBeDefined();
    const wellKnown = await relay.app.request('/.well-known/dfos-relay');
    expect(wellKnown.status).toBe(200);
    expect((await store.getStats()).countsByKind.identity).toBe(1);
    const log = await relay.app.request('/proof/v1/log?limit=1');
    expect(log.status).toBe(200);
    expect(await log.json()).toMatchObject({ next: expect.any(String) });
    expect((await relay.app.request('/proof/v1/log?after=unknown')).status).toBe(400);
  });

  it('commits and reads a content-addressed blob without duplicating it', async () => {
    const key = { creatorDID: 'creator', documentCID: 'document' };
    expect(await store.getBlob(key)).toBeUndefined();
    const bytes = new TextEncoder().encode('document bytes');
    expect(await store.commit({ kind: 'blob', key, bytes })).toBe('new');
    expect(await store.commit({ kind: 'blob', key, bytes })).toBe('new');
    expect(Array.from((await store.getBlob(key))!)).toEqual(Array.from(bytes));
  });

  it.runIf(process.env.RELAY_LIVE_PEER_CHECK === '1')(
    'syncs two real relay.dfos.com pages and resumes its opaque next cursor', async () => {
      const transport = createHttpPeerClient();
      let fetched = false;
      let received: { cid: string }[] = [];
      let expectedCursor: string | null = null;
      let resumed = false;
      const relay = await createRelay({
        store, content: true,
        peers: [{ url: 'https://relay.dfos.com', sync: true, fetch: false, push: false }],
        peerClient: {
          ...transport,
          async getOperationLog(url, params) {
            if (fetched) return null;
            fetched = true;
            resumed = Boolean(params?.after);
            const page = await transport.getOperationLog(url, { ...params, limit: 3 });
            if (!page || page === 'invalid-cursor') throw new Error('live peer page unavailable');
            received = page.entries;
            expectedCursor = page.next;
            return page;
          },
        },
      });
      for (let cycle = 0; cycle < 2; cycle++) {
        fetched = false;
        await relay.syncFromPeers();
        expect(received).toHaveLength(3);
        for (const entry of received) expect(await store.getOperation(entry.cid)).toBeDefined();
        expect(expectedCursor).toBeTruthy();
        expect(await store.getPeerCursor('https://relay.dfos.com')).toBe(expectedCursor);
        expect(resumed).toBe(cycle > 0);
      }
    }, 30_000,
  );

  it('reads a DAG with a revoked delegation by dropping its operation and subtree, without throwing', async () => {
    async function identity() {
      const pair = createNewEd25519Keypair();
      const privateKeyHex = bytesToHex(pair.privateKey);
      const chain = await createIdentityChain({ privateKeyHex, publicKeyHex: bytesToHex(pair.publicKey) });
      const state = await verifyChain(chain.log);
      await store.putIdentityChain({
        did: chain.did, log: chain.log, state, headCID: chain.operationCID,
        lastCreatedAt: new Date().toISOString(),
      });
      return { ...chain, signer: createSigner(privateKeyHex), keyId: state.authKeys[0].id };
    }
    const creator = await identity();
    const delegate = await identity();
    const doc = (await dagCborCanonicalEncode({ type: 'post', title: 'DAG regression' })).cid.toString();
    const at = Date.now() + 1000;
    const create = await signContentOperation({
      operation: { version: 1, type: 'create', did: creator.did, documentCID: doc, baseDocumentCID: null, createdAt: new Date(at).toISOString() },
      signer: creator.signer, kid: `${creator.did}#${creator.keyId}`,
    });
    const resolveKey = createAsOfKeyResolver(store);
    const resolveIdentity = createIdentityResolver(store);
    const genesis = await verifyContentChain({ log: [create.jwsToken], resolveKey });
    const credential = await createDFOSCredential({
      issuerDID: creator.did, audienceDID: delegate.did, att: [{ resource: `chain:${genesis.contentId}`, action: 'write' }],
      iat: Math.floor(at / 1000) - 60, exp: Math.floor(at / 1000) + 3600,
      signer: creator.signer, keyId: creator.keyId,
    });
    const update = await signContentOperation({
      operation: { version: 1, type: 'update', did: delegate.did, previousOperationCID: create.operationCID,
        documentCID: doc, baseDocumentCID: null, createdAt: new Date(at + 1000).toISOString(), authorization: credential },
      signer: delegate.signer, kid: `${delegate.did}#${delegate.keyId}`,
    });
    const child = await signContentOperation({
      operation: { version: 1, type: 'update', did: creator.did, previousOperationCID: update.operationCID,
        documentCID: doc, baseDocumentCID: null, createdAt: new Date(at + 2000).toISOString() },
      signer: creator.signer, kid: `${creator.did}#${creator.keyId}`,
    });
    const log = [create.jwsToken, update.jwsToken, child.jwsToken];
    const options = { resolveKey, resolveIdentity, enforceAuthorization: true,
      isRevoked: store.isCredentialRevoked.bind(store) };
    const before = await verifyContentDag({ log, ...options });
    expect(before.rejected).toEqual([]);
    await store.commit({ ...operation(child.operationCID),
      contentChain: { contentId: genesis.contentId, genesisCID: create.operationCID,
        log, state: before.head, lastCreatedAt: before.headCreatedAt } });
    const credentialCID = decodeDFOSCredentialUnsafe(credential)!.header.cid!;
    await store.commit({ ...operation('dag-revocation'), revocation: revocation(
      'dag-revocation', creator.did, credentialCID, new Date(at).toISOString(),
    ) });
    const stored = await store.getContentChain(genesis.contentId);
    const after = await verifyContentDag({ log: stored!.log, ...options });
    expect(after.head.headCID).toBe(create.operationCID);
    expect(after.rejected.map((rejected) => rejected.cid)).toEqual([update.operationCID, child.operationCID]);
    expect(after.rejected[0].reason).toContain('revoked');
    expect(stored!.log).toHaveLength(3);
  });

  it('applies the additive migration twice without losing history', async () => {
    await store.commit(operation('preserved'));
    await database.exec(migration);
    await database.exec(migration);
    expect(await store.getOperation('preserved')).toBeDefined();
  });

  it('commits once, preserves receipt time, and emits next only on full pages', async () => {
    expect(await store.commit(operation('one'))).toBe('new');
    expect(await store.commit(operation('one'))).toBe('duplicate');
    expect(await store.readLog({ limit: 1 })).toEqual({ entries: [operation('one').logEntry], next: 'one' });
    expect(await store.readLog({ after: 'one', limit: 1 })).toEqual({ entries: [], next: null });
    expect(await store.readLog({ after: 'unknown', limit: 1 })).toBeNull();
    expect(await store.getStats()).toMatchObject({ opCount: 1, headCid: 'one', countsByKind: { artifact: 1 } });
  });

  it('rolls back the entire commit after a late write fault', async () => {
    await database.exec(`CREATE FUNCTION relay.fail_log() RETURNS trigger LANGUAGE plpgsql AS
      $$ BEGIN RAISE EXCEPTION 'injected log failure'; END $$;
      CREATE TRIGGER fail_log BEFORE INSERT ON relay.relay_operation_log
      FOR EACH ROW EXECUTE FUNCTION relay.fail_log()`);
    try {
      await expect(store.commit(operation('rollback'))).rejects.toThrow();
      expect(await store.getOperation('rollback')).toBeUndefined();
    } finally {
      await database.exec('DROP TRIGGER fail_log ON relay.relay_operation_log; DROP FUNCTION relay.fail_log()');
    }
  });

  it('rejects inconsistent log and dual-chain batches without persisting', async () => {
    await expect(store.commit({ ...operation('invalid'), logEntry: operation('other').logEntry })).rejects.toThrow('log entry');
    await expect(store.commit({
      ...operation('invalid'), identityChain: {} as never, contentChain: {} as never,
    })).rejects.toThrow('one chain');
    expect(await store.getOperation('invalid')).toBeUndefined();
  });

  it('reads revoked, non-revoked and other-issuer credentials distinctly', async () => {
    const rev = revocation('rev');
    await store.commit({ ...operation('rev'), revocation: rev });
    expect(await store.getRevocation('issuer', 'credential')).toEqual(rev);
    expect(await store.getRevocation('issuer', 'not-revoked')).toBeUndefined();
    expect(await store.getRevocation('stranger', 'credential')).toBeUndefined();
    expect(await store.isCredentialRevoked('issuer', 'not-revoked')).toBe(false);
    expect(await store.isCredentialRevoked('issuer', 'credential', Date.parse(timestamp) / 1000 - 1)).toBe(false);
    expect(await store.isCredentialRevoked('issuer', 'credential', Date.parse(timestamp) / 1000)).toBe(true);
    expect(await store.isCredentialRevoked('issuer', 'credential', 0)).toBe(true);
  });

  it('keeps the earliest boundary and deterministic issuer/CID order', async () => {
    await store.addRevocation(revocation('later', 'z', 'credential', '2026-02-01T00:00:00.000Z'));
    await store.addRevocation(revocation('earlier', 'z'));
    await store.addRevocation(revocation('later-again', 'z', 'credential', '2026-03-01T00:00:00.000Z'));
    await store.addRevocation(revocation('a', 'a'));
    await store.addRevocation(revocation('z-last', 'z', 'z-credential'));
    expect((await store.getRevocation('z', 'credential'))?.cid).toBe('earlier');
    expect((await store.getRevocationForCredential('credential'))?.issuerDID).toBe('a');
    expect(await store.getRevocationForCredential('absent')).toBeUndefined();
    expect((await store.getRevocationsByIssuer('z')).map((rev) => rev.credentialCID)).toEqual(['credential', 'z-credential']);
  });

  it('treats legacy unknown signed boundaries as timeless, not receipt time', async () => {
    await database.exec(`INSERT INTO relay.relay_revocations
      (cid, issuer_did, credential_cid, jws_token) VALUES ('legacy', 'issuer', 'credential', 'signed')`);
    expect(await store.isCredentialRevoked('issuer', 'credential', 1)).toBe(true);
  });

  it('breaks equal whole-second boundaries by CID and treats malformed boundaries timelessly', async () => {
    await store.addRevocation(revocation('z', 'issuer', 'credential', '2026-01-01T00:00:00.100Z'));
    await store.addRevocation(revocation('a', 'issuer', 'credential', '2026-01-01T00:00:00.900Z'));
    expect((await store.getRevocation('issuer', 'credential'))?.cid).toBe('a');
    await store.addRevocation(revocation('malformed', 'issuer', 'credential', 'not-a-timestamp'));
    expect(await store.isCredentialRevoked('issuer', 'credential', 1)).toBe(true);
    await store.addRevocation(revocation('valid-later'));
    expect((await store.getRevocation('issuer', 'credential'))?.cid).toBe('malformed');
  });

  it('fails closed on incomplete held credentials instead of pretending they are absent', async () => {
    await database.exec("INSERT INTO relay.relay_public_credentials (cid) VALUES ('incomplete')");
    await expect(store.getPublicCredentialByCID('incomplete')).rejects.toThrow('Incomplete');
  });

  it('hides credentials only for their issuer and retains the revocation attestation and history', async () => {
    const credential = {
      cid: 'credential', issuerDID: 'issuer', att: [{ resource: 'chain:*', action: 'read' }],
      exp: 2_000_000_000, jwsToken: 'signed-credential', createdAt: timestamp, ingestedAt: timestamp,
    };
    await store.commit({ ...operation('credential'), publicCredential: credential });
    expect(await store.getPublicCredentialByCID('credential')).toEqual(credential);
    expect(await store.getPublicCredentials('chain:example')).toEqual(['signed-credential']);
    const stranger = revocation('stranger-rev', 'stranger');
    await store.commit({ ...operation(stranger.cid), revocation: stranger,
      removePublicCredential: { issuerDID: 'stranger', credentialCID: 'credential' } });
    expect(await store.getPublicCredentialByCID('credential')).toEqual(credential);
    const own = revocation('own-rev');
    await store.commit({ ...operation(own.cid), revocation: own,
      removePublicCredential: { issuerDID: 'issuer', credentialCID: 'credential' } });
    expect(await store.getPublicCredentialByCID('credential')).toBeUndefined();
    expect(await store.getPublicCredentials('chain:example')).toEqual([]);
    const history = await database.query('SELECT revoked_by FROM relay.relay_public_credentials');
    expect(history.rows).toEqual([{ revoked_by: 'own-rev' }]);
    expect(await store.getOperation('own-rev')).toBeDefined();
  });

  it('refuses credential removal without its signed revocation', async () => {
    await expect(store.commit({ ...operation('unsigned-removal'),
      removePublicCredential: { issuerDID: 'issuer', credentialCID: 'credential' } })).rejects.toThrow('issuer-signed');
    expect(await store.getOperation('unsigned-removal')).toBeUndefined();
  });

  it('pages pending operations past stalled entries and retains peer provenance', async () => {
    await store.putRawOp('a', 'first', 'peer');
    await store.putRawOp('b', 'second');
    await store.putRawOp('a', 'duplicate', 'direct');
    expect(await store.getUnsequencedOps('', 1)).toEqual([{ cursor: 'a', jwsToken: 'first', origin: 'peer' }]);
    expect(await store.getUnsequencedOps('a', 1)).toEqual([{ cursor: 'b', jwsToken: 'second', origin: 'direct' }]);
    await store.markOpsSequenced(['b']);
    await store.markOpRejected('a', 'invalid signature');
    await store.resetSequencer();
    expect(await store.countUnsequenced()).toBe(1);
    expect((await store.getUnsequencedOps('', 10)).map((row) => row.cursor)).toEqual(['b']);
    await store.setPeerCursor('https://relay.dfos.com', 'last');
    expect(await store.getPeerCursor('https://relay.dfos.com')).toBe('last');
  });
});
