/**
 * #1883 requires: "Post-accept auth: the agent authenticates via the
 * existing challenge-response flow using the publicKey submitted in the
 * knock." This test proves that composition end-to-end at the crypto level
 * — using the REAL crypto module (unlike knock.test.ts, which stubs
 * `didFromPublicKey` for determinism) — without needing to stand up the
 * actual challenge/login-verify Next.js routes, which already have their
 * own generic test coverage against any `identities` row.
 *
 * The guarantee under test: after `acceptKnock()` mints an identity, the
 * row's `publicKey` column is exactly the key that was escrowed at knock
 * time, and a signature produced by the corresponding private key verifies
 * against it — precisely what `POST /auth/api/challenge` +
 * `POST /auth/api/login/verify` rely on for any identity.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

type Row = Record<string, unknown>;
type Predicate = (row: Row) => boolean;

const { identitiesStore, knocksStore, connectionsStore, IDENTITIES_TABLE, KNOCKS_TABLE, CONNECTIONS_TABLE } = vi.hoisted(() => ({
  identitiesStore: new Map<string, Row>(),
  knocksStore: new Map<string, Row>(),
  connectionsStore: new Map<string, Row>(),
  IDENTITIES_TABLE: { __table: 'identities', id: 'id', publicKey: 'publicKey' },
  KNOCKS_TABLE: {
    __table: 'agent_knocks',
    id: 'id', publicKey: 'publicKey', agentDid: 'agentDid', declaredTarget: 'declaredTarget',
    selfDescription: 'selfDescription', requestedCapabilities: 'requestedCapabilities', externalDid: 'externalDid',
    status: 'status', expiresAt: 'expiresAt', respondedAt: 'respondedAt', createdAt: 'createdAt',
  },
  CONNECTIONS_TABLE: { __table: 'connections', didA: 'didA', didB: 'didB', connectedAt: 'connectedAt', disconnectedAt: 'disconnectedAt' },
}));

function storeFor(table: { __table: string }): Map<string, Row> {
  if (table.__table === 'identities') return identitiesStore;
  if (table.__table === 'agent_knocks') return knocksStore;
  if (table.__table === 'connections') return connectionsStore;
  throw new Error(`unknown table ${table.__table}`);
}
function keyFor(table: { __table: string }, row: Row): string {
  return table.__table === 'connections' ? `${row.didA as string}::${row.didB as string}` : String(row.id);
}

/** Whether `candidate` matches `row` on every column named in `target` — the onConflictDoUpdate match predicate. */
function matchesConflictTarget(row: Row, candidate: Row, target: string[]): boolean {
  return target.every((col) => candidate[col] === row[col]);
}

vi.mock('drizzle-orm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('drizzle-orm')>();
  const eq = (column: string, value: unknown): Predicate => (row) => row[column] === value;
  const gt = (column: string, value: unknown): Predicate => (row) => {
    const raw = row[column] as Date | undefined;
    return raw !== undefined && raw.getTime() > (value as Date).getTime();
  };
  const and = (...preds: Predicate[]): Predicate => (row) => preds.every((p) => p(row));
  return { ...actual, eq, gt, and };
});

function queryable(rows: Row[]) {
  const p = Promise.resolve(rows);
  return { then: p.then.bind(p), catch: p.catch.bind(p), finally: p.finally.bind(p), limit: (n: number) => Promise.resolve(rows.slice(0, n)), returning: () => Promise.resolve(rows) };
}

function insertRows(table: { __table: string }, rows: Row[]): Promise<Row[]> {
  for (const row of rows) storeFor(table).set(keyFor(table, row), { ...row });
  return Promise.resolve(rows);
}

function applyOnConflictDoUpdate(table: { __table: string }, rows: Row[], { target, set }: { target: string[]; set: Row }) {
  const row = rows[0];
  const existing = [...storeFor(table).entries()].find(([, r]) => matchesConflictTarget(row, r, target));
  if (existing) storeFor(table).set(existing[0], { ...existing[1], ...set });
  else storeFor(table).set(keyFor(table, row), { ...row });
  return Promise.resolve([]);
}

function insertInto(table: { __table: string }) {
  return {
    values: (data: Row | Row[]) => {
      const rows = Array.isArray(data) ? data : [data];
      return {
        then: (f?: (v: Row[]) => unknown, r?: (e: unknown) => unknown) => insertRows(table, rows).then(f, r),
        catch: (r?: (e: unknown) => unknown) => insertRows(table, rows).catch(r),
        onConflictDoUpdate: (params: { target: string[]; set: Row }) => applyOnConflictDoUpdate(table, rows, params),
      };
    },
  };
}

function selectFrom() {
  return {
    from: (table: { __table: string }) => ({
      where: (predicate: Predicate) => queryable([...storeFor(table).values()].filter(predicate)),
    }),
  };
}

function applyUpdate(table: { __table: string }, patch: Row, predicate: Predicate): Row[] {
  const touched: Row[] = [];
  for (const [key, row] of storeFor(table)) {
    if (!predicate(row)) continue;
    const next = { ...row, ...patch };
    storeFor(table).set(key, next);
    touched.push(next);
  }
  return touched;
}

function updateTable(table: { __table: string }) {
  return {
    set: (patch: Row) => ({
      where: (predicate: Predicate) => queryable(applyUpdate(table, patch, predicate)),
    }),
  };
}

vi.mock('@/src/db', () => ({
  db: { insert: insertInto, select: selectFrom, update: updateTable },
  identities: IDENTITIES_TABLE,
  agentKnocks: KNOCKS_TABLE,
  connections: CONNECTIONS_TABLE,
  attestations: { __table: 'attestations' },
}));

vi.mock('@/src/lib/kernel/id', () => {
  let counter = 0;
  return { generateId: (prefix: string) => `${prefix}_${++counter}` };
});
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: vi.fn().mockResolvedValue('') }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@imajin/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('@imajin/cid', () => ({ computeCid: vi.fn().mockResolvedValue('cid_fixed') }));

// Deliberately NOT mocking '@/src/lib/auth/crypto' — this test exercises the
// real Ed25519 keygen/derive/sign/verify implementation. generateKeypair
// lives in @imajin/auth (see apps/kernel/app/auth/api/agents/route.ts for
// the same import split); everything DID/challenge-shaped is kernel-local.
import { generateKeypair, crypto as authCrypto } from '@imajin/auth';
import { didFromPublicKey, verifySignature, generateChallenge } from '../crypto';
import { submitKnock, acceptKnock } from '../knock';

const TARGET_DID = 'did:imajin:ryan';

beforeEach(() => {
  identitiesStore.clear();
  knocksStore.clear();
  connectionsStore.clear();
  identitiesStore.set(TARGET_DID, { id: TARGET_DID, scope: 'actor', subtype: 'human', publicKey: 'target-pubkey', handle: 'ryan', tier: 'established' });
});

describe('challenge-response against a knock-minted identity', () => {
  it('a signature from the knock keypair verifies against the minted identity\u2019s stored public key', async () => {
    const { privateKey, publicKey } = generateKeypair();
    const expectedAgentDid = didFromPublicKey(publicKey);

    const submitted = await submitKnock({
      publicKey,
      declaredTarget: TARGET_DID,
      selfDescription: 'A matchmaking agent for professional intros.',
      requestedCapabilities: ['intros:propose'],
    });
    if (!('knock' in submitted)) throw new Error('expected knock');
    expect(submitted.knock.agentDid).toBe(expectedAgentDid);

    // Escrow: no identity exists yet for this key.
    expect(identitiesStore.has(expectedAgentDid)).toBe(false);

    const accepted = await acceptKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });
    if (!('result' in accepted)) throw new Error('expected result');
    expect(accepted.result.agentDid).toBe(expectedAgentDid);

    const mintedIdentity = identitiesStore.get(expectedAgentDid);
    expect(mintedIdentity?.publicKey).toBe(publicKey);

    // Exactly the mechanics POST /auth/api/challenge + POST /auth/api/login/verify use.
    const challenge = generateChallenge();
    const signature = authCrypto.signSync(challenge, privateKey);
    await expect(verifySignature(challenge, signature, mintedIdentity!.publicKey as string)).resolves.toBe(true);
  });

  it('a signature from a different keypair does NOT verify against the minted identity', async () => {
    const { privateKey: knockPrivateKey, publicKey: knockPublicKey } = generateKeypair();
    const { privateKey: impostorPrivateKey } = generateKeypair();

    const submitted = await submitKnock({
      publicKey: knockPublicKey,
      declaredTarget: TARGET_DID,
      selfDescription: 'A matchmaking agent for professional intros.',
      requestedCapabilities: [],
    });
    if (!('knock' in submitted)) throw new Error('expected knock');
    const accepted = await acceptKnock({ knockId: submitted.knock.knockId, requestedBy: TARGET_DID });
    if (!('result' in accepted)) throw new Error('expected result');

    const mintedIdentity = identitiesStore.get(accepted.result.agentDid);
    const challenge = generateChallenge();
    const impostorSignature = authCrypto.signSync(challenge, impostorPrivateKey);

    await expect(verifySignature(challenge, impostorSignature, mintedIdentity!.publicKey as string)).resolves.toBe(false);
    // Sanity: the legitimate key still works.
    const legitSignature = authCrypto.signSync(challenge, knockPrivateKey);
    await expect(verifySignature(challenge, legitSignature, mintedIdentity!.publicKey as string)).resolves.toBe(true);
  });
});
