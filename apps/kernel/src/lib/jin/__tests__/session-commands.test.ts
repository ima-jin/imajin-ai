import { PGlite } from '@electric-sql/pglite';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize, crypto as crypto } from '@imajin/auth';
import { createHash } from 'node:crypto';
const mocks = vi.hoisted(() => ({
  client: vi.fn(), execute: vi.fn(), resolver: vi.fn(), service: vi.fn(), issuer: vi.fn(),
}));
vi.mock('@imajin/db', () => ({ getClient: () => mocks.client }));
vi.mock('@/src/db', () => ({ db: { execute: mocks.execute }, identities: {} }));
vi.mock('@imajin/auth/resolve-db', () => ({ createDbResolver: () => mocks.resolver }));
vi.mock('@/src/lib/auth/agent-service', () => ({ listServiceOf: mocks.service }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDidFromConfig: mocks.issuer }));
import { prepareSessionCommand, dispatchSessionCommand, verifySessionCommand, deliverSessionCommand } from '../session-commands';
import { getSessionBinding, hasSessionBinding, ingestSessionCommandFrame } from '../session-command-intake';
import { resolveSessionCommandTarget } from '../session-command-authority';
import { getSessionEvent, insertSessionCommand, sessionEventId } from '../session-command-store';
import { parseSessionCommandPayload, sessionCommandBody, type SessionCommandFrame, type SessionCommandType } from '../session-command-contract';

const pg = new PGlite();
const principal = 'did:imajin:principal';
const agent = 'did:imajin:agent';
const loopId = 'openclaw:run';
const agentKey = crypto.generateKeypair();
const principalKey = crypto.generateKeypair();
const kernelKey = crypto.generateKeypair();
const registry = new Map<string, string>();
function tagged(executor: Pick<PGlite, 'query'>) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((value, part, index) => value + (index ? `$${index}` : '') + part, '');
    return (await executor.query(query, values)).rows;
  };
}
function envelope(payload: Record<string, unknown>, from = agent, timestamp = Date.now()) {
  const signed = { from, type: 'agent' as const, timestamp, payload };
  return { ...signed, signature: crypto.signSync(canonicalize(signed), agentKey.privateKey) };
}
async function lifecycle(type = 'loop.started', publisher = agent, id = loopId) {
  const payload = { loopId: id, principal, kind: 'openclaw.session', state: 'running', parentLoopId: null, summary: 'Started', at: new Date().toISOString() };
  const proof = { type, payload, publisherDid: publisher, signature: { alg: 'ed25519', keyId: agentKey.publicKey, sig: crypto.signSync(canonicalize({ type, payload }), agentKey.privateKey) } };
  await pg.query(`INSERT INTO kernel.loop_events (id,loop_id,type,issuer,principal,payload,occurred_at)
    VALUES ($1,$2,$3,$4,$5,$6,NOW())`, [crypto.generateKeypair().publicKey, id, type, publisher, principal, JSON.stringify({ publisherProof: proof })]);
}
async function signCommand(type: SessionCommandType = 'session.send', payload: Record<string, string> = { loopId, message: 'Hello' }) {
  const frame = await prepareSessionCommand(loopId, principal, type, payload);
  return {
    ...frame, countersignature: {
      keyId: principalKey.publicKey, alg: 'ed25519' as const,
      sig: crypto.signSync(canonicalize(sessionCommandBody(frame)), principalKey.privateKey),
    },
  };
}
function outcome(frame: SessionCommandFrame, extra: Record<string, unknown> = {}) {
  const payload = {
    eventType: `loop.${frame.type}.completed`, commandId: frame.commandId, command: frame.type,
    outcome: 'completed', principal, issuer: frame.issuer, agentDid: agent,
    payloadHash: createHash('sha256').update(canonicalize(frame.payload)).digest('hex'),
    at: new Date().toISOString(), loopId, parentLoopId: null,
    ...(frame.payload.approvalId ? { approvalId: frame.payload.approvalId } : {}), ...extra,
  };
  return { type: payload.eventType, attestation: envelope(payload) };
}
function binding(extra: Record<string, unknown> = {}) {
  return { type: 'loop.approval.bound', attestation: envelope({ loopId, principalDid: principal, agentDid: agent, approvalId: 'native-approval', ...extra }) };
}

beforeAll(async () => {
  await pg.exec(`CREATE SCHEMA kernel;
    CREATE TABLE kernel.loops (
      loop_id text PRIMARY KEY, kind text NOT NULL, principal text NOT NULL,parent_loop_id text,
      state text NOT NULL,summary text NOT NULL DEFAULT '',last_event_type text NOT NULL DEFAULT 'loop.started',
      started_at timestamptz NOT NULL DEFAULT NOW(),last_seen_at timestamptz NOT NULL DEFAULT NOW(),finished_at timestamptz);
    CREATE TABLE kernel.loop_events (
      id text PRIMARY KEY,loop_id text NOT NULL,type text NOT NULL,issuer text NOT NULL,principal text NOT NULL,
      payload jsonb NOT NULL,occurred_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT NOW());`);
  mocks.client.mockImplementation(tagged(pg));
  Object.assign(mocks.client, { begin: (work: (tx: ReturnType<typeof tagged>) => Promise<unknown>) => pg.transaction(tx => work(tagged(tx))) });
  mocks.execute.mockImplementation(async (query: SQL) => {
    const compiled = new PgDialect().sqlToQuery(query);
    return (await pg.query(compiled.sql, compiled.params)).rows;
  });
}, 30_000);
afterAll(() => pg.close());
beforeEach(async () => {
  await pg.exec('TRUNCATE kernel.loop_events,kernel.loops');
  await pg.query(`INSERT INTO kernel.loops (loop_id,kind,principal,state) VALUES ($1,'openclaw.session',$2,'running')`, [loopId, principal]);
  await lifecycle();
  registry.clear(); registry.set(agent, agentKey.publicKey); registry.set(principal, principalKey.publicKey);
  mocks.resolver.mockImplementation(async (did: string) => registry.has(did) ? { publicKey: registry.get(did) } : null);
  mocks.service.mockResolvedValue([principal]);
  mocks.issuer.mockResolvedValue('did:imajin:kernel');
  vi.stubEnv('AUTH_PRIVATE_KEY', kernelKey.privateKey);
  vi.stubEnv('AUTH_INTERNAL_API_KEY', 'inert-internal-test-fixture');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ delivered: true })));
});

describe('secure session command grant and wish', () => {
  it('signs only the documented full body and durably claims one own-agent dispatch', async () => {
    const frame = await signCommand();
    expect(Object.keys(sessionCommandBody(frame)).sort()).toEqual(['commandId', 'expiresAt', 'issuedAt', 'issuer', 'payload', 'principal', 'to', 'type']);
    expect(crypto.verifySync(frame.signature.sig, canonicalize(sessionCommandBody(frame)), kernelKey.publicKey)).toBe(true);
    expect(await dispatchSessionCommand(loopId, principal, frame)).toEqual({ commandId: frame.commandId, delivered: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/chat/api/internal/session-command');
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body))).toEqual({ targetDid: agent, command: frame });
    await expect(dispatchSessionCommand(loopId, principal, frame)).rejects.toThrow('already consumed');
    expect(await deliverSessionCommand(loopId, frame)).toEqual({ commandId: frame.commandId, delivered: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each([
    ['session.send', { loopId, message: 'Hello', agentId: 'assistant' }],
    ['session.abort', { loopId, runId: 'run-1' }],
    ['session.spawn', { parentLoopId: loopId, task: 'Investigate', group: 'blue', model: 'model-a', label: 'Child', agentId: 'assistant' }],
  ] as [SessionCommandType, Record<string, string>][])('accepts documented %s payload', async (type, payload) => {
    const frame = await signCommand(type, payload);
    expect(await verifySessionCommand(loopId, principal, frame)).toEqual(frame);
  });
  it.each(['session.approve', 'session.deny'] as SessionCommandType[])('routes %s only through bound approval transaction', async type => {
    await ingestSessionCommandFrame(agent, binding());
    const frame = await signCommand(type, { loopId, approvalId: 'native-approval', kind: 'exec' });
    await expect(verifySessionCommand(loopId, principal, frame)).rejects.toThrow('decision endpoint');
    expect(await verifySessionCommand(loopId, principal, frame, { approvalId: 'native-approval' })).toEqual(frame);
    await expect(verifySessionCommand(loopId, principal, frame, { approvalId: 'different' })).rejects.toThrow();
  });
  it('covers converted send/spawn/abort approval association and cannot bypass approval endpoint', async () => {
    await ingestSessionCommandFrame(agent, binding());
    for (const [type, payload] of [
      ['session.send', { loopId, message: 'Approved alternative', approvalId: 'native-approval' }],
      ['session.abort', { loopId, approvalId: 'native-approval' }],
      ['session.spawn', { parentLoopId: loopId, task: 'Alternative', approvalId: 'native-approval' }],
    ] as [SessionCommandType, Record<string, string>][]) {
      const frame = await signCommand(type, payload);
      await expect(dispatchSessionCommand(loopId, principal, frame)).rejects.toThrow('decision endpoint');
      await expect(verifySessionCommand(loopId, principal, frame, { approvalId: 'native-approval' })).resolves.toEqual(frame);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['sessionKey', 'parentSessionKey', 'permissionMode', 'toolOverrides', 'execNode', 'incognito', 'arbitrary'])('rejects forbidden payload field %s before signing', async field => {
    await expect(prepareSessionCommand(loopId, principal, 'session.send', { loopId, message: 'Hello', [field]: 'forbidden' })).rejects.toThrow();
  });
  it('rejects malformed/oversized types, target mismatch and unparented spawn on run route', async () => {
    expect(() => parseSessionCommandPayload('session.send', { loopId, message: '' })).toThrow();
    expect(() => parseSessionCommandPayload('session.send', { loopId, message: 'x'.repeat(16001) })).toThrow();
    await expect(signCommand('session.abort', { loopId: 'foreign' })).rejects.toThrow('address this run');
    await expect(signCommand('session.spawn', { task: 'root' })).rejects.toThrow('address this run');
    await expect(signCommand('session.approve', { loopId, approvalId: 'unknown' })).rejects.toThrow('binding required');
  });
  it('fails closed on unknown principal keys, key rotation and missing wish', async () => {
    const frame = await signCommand();
    await expect(verifySessionCommand(loopId, principal, { ...frame, countersignature: undefined })).rejects.toThrow('wish');
    registry.delete(principal);
    await expect(verifySessionCommand(loopId, principal, frame)).rejects.toThrow('key unavailable');
    registry.set(principal, crypto.generateKeypair().publicKey);
    await expect(verifySessionCommand(loopId, principal, frame)).rejects.toThrow('wish');
  });
  it('verifies kernel grant rather than trusting kernel-looking fields', async () => {
    const frame = await signCommand();
    await expect(verifySessionCommand(loopId, principal, { ...frame, payload: { ...frame.payload, message: 'altered' } })).rejects.toThrow('kernel grant');
    await expect(verifySessionCommand(loopId, principal, { ...frame, signature: { ...frame.signature, keyId: agentKey.publicKey } })).rejects.toThrow('kernel grant');
    for (const field of ['to', 'principal', 'issuer']) {
      await expect(verifySessionCommand(loopId, principal, { ...frame, [field]: 'did:imajin:foreign' })).rejects.toThrow('identity mismatch');
    }
    vi.stubEnv('AUTH_PRIVATE_KEY', crypto.generateKeypair().privateKey);
    await expect(verifySessionCommand(loopId, principal, frame)).rejects.toThrow('kernel grant');
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    await expect(signCommand()).rejects.toThrow('signing unavailable');
  });
  it('refuses unconfigured issuer rather than substituting relay identity', async () => {
    mocks.issuer.mockResolvedValue('');
    await expect(signCommand()).rejects.toThrow('issuer unavailable');
  });
  it('rejects time manipulation, unsupported algorithms and extra frame properties', async () => {
    const frame = await signCommand();
    for (const extra of [
      { expiresAt: new Date(Date.now() - 1).toISOString() },
      { expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() },
      { issuedAt: new Date(Date.now() + 120_000).toISOString() },
    ]) await expect(verifySessionCommand(loopId, principal, { ...frame, ...extra })).rejects.toThrow('time window');
    await expect(verifySessionCommand(loopId, principal, { ...frame, untrusted: true })).rejects.toThrow();
    await expect(verifySessionCommand(loopId, principal, { ...frame, signature: { ...frame.signature, alg: 'rsa' } })).rejects.toThrow();
    await expect(verifySessionCommand(loopId, principal, frame, { approvalId: 'unused' })).rejects.toThrow('association mismatch');
  });
  it.each(['offline', 'network', 'http', 'missing-key'])('persists honest undelivered %s status without retrying', async mode => {
    const frame = await signCommand();
    if (mode === 'offline') vi.mocked(fetch).mockResolvedValue(Response.json({ delivered: false }));
    if (mode === 'network') vi.mocked(fetch).mockRejectedValue(new Error('private error'));
    if (mode === 'http') vi.mocked(fetch).mockResolvedValue(new Response('', { status: 503 }));
    if (mode === 'missing-key') vi.stubEnv('AUTH_INTERNAL_API_KEY', '');
    expect(await dispatchSessionCommand(loopId, principal, frame)).toEqual({ commandId: frame.commandId, delivered: false });
    expect((await getSessionEvent('transport', frame.commandId, principal))?.payload.delivered).toBe(false);
    expect(await deliverSessionCommand(loopId, frame)).toEqual({ commandId: frame.commandId, delivered: false });
    expect(vi.mocked(fetch).mock.calls.length).toBeLessThanOrEqual(1);
  });
  it('refuses unpersisted or altered commands before delivery and treats lost attempt receipt as unknown', async () => {
    const frame = await signCommand();
    await expect(deliverSessionCommand(loopId, frame)).rejects.toThrow('durably queued');
    await insertSessionCommand({ execute: mocks.execute } as never, loopId, frame);
    await pg.query(`INSERT INTO kernel.loop_events (id,loop_id,type,issuer,principal,payload,occurred_at) VALUES ($1,$2,'loop.command.dispatching',$3,$4,'{}',NOW())`,
      [sessionEventId('attempt', frame.commandId), loopId, frame.issuer, principal]);
    expect(await deliverSessionCommand(loopId, frame)).toEqual({ commandId: frame.commandId, delivered: false });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('originating agent proof', () => {
  it('matches plugin running and blocked states', async () => {
    expect(await resolveSessionCommandTarget(loopId, principal)).toBe(agent);
    await pg.exec(`UPDATE kernel.loops SET state='blocked'`);
    expect(await resolveSessionCommandTarget(loopId, principal)).toBe(agent);
  });
  it('denies absent/terminal ownership and removed service bindings', async () => {
    await expect(resolveSessionCommandTarget(loopId, 'did:imajin:other')).rejects.toThrow('not found');
    await pg.exec(`UPDATE kernel.loops SET finished_at=NOW()`);
    await expect(resolveSessionCommandTarget(loopId, principal)).rejects.toThrow('not active');
    await pg.exec(`UPDATE kernel.loops SET finished_at=NULL,state='finished'`);
    await expect(resolveSessionCommandTarget(loopId, principal)).rejects.toThrow('not active');
    await pg.exec(`UPDATE kernel.loops SET state='running'`);
    mocks.service.mockResolvedValue([]);
    await expect(resolveSessionCommandTarget(loopId, principal)).rejects.toThrow('no longer serves');
  });
  it('rejects multiple publishers, missing proof, missing origin and revoked agent key', async () => {
    await lifecycle('loop.progress', 'did:imajin:node');
    await expect(resolveSessionCommandTarget(loopId, principal)).rejects.toThrow('Ambiguous');
    await pg.exec(`DELETE FROM kernel.loop_events WHERE type='loop.progress'`);
    registry.set(agent, crypto.generateKeypair().publicKey);
    await expect(resolveSessionCommandTarget(loopId, principal)).rejects.toThrow('stale or invalid');
    registry.set(agent, agentKey.publicKey);
    await pg.exec(`UPDATE kernel.loop_events SET payload='{}'`);
    await expect(resolveSessionCommandTarget(loopId, principal)).rejects.toThrow('stale or invalid');
    await pg.exec(`UPDATE kernel.loop_events SET type='loop.progress'`);
    await expect(resolveSessionCommandTarget(loopId, principal)).rejects.toThrow('Origin proof');
    await pg.exec(`DELETE FROM kernel.loop_events`);
    await expect(resolveSessionCommandTarget(loopId, principal)).rejects.toThrow('Origin proof');
  });
  it('does not accept a valid proof under a different event phase', async () => {
    await lifecycle('loop.progress');
    await pg.exec(`UPDATE kernel.loop_events SET type='loop.blocked' WHERE type='loop.progress'`);
    await expect(resolveSessionCommandTarget(loopId, principal)).rejects.toThrow('stale or invalid');
  });
  it('keeps verified origin after sanitized progress but never accepts a mixed publisher', async () => {
    await lifecycle('loop.progress');
    await pg.exec(`UPDATE kernel.loop_events SET payload='{}' WHERE type='loop.progress'`);
    expect(await resolveSessionCommandTarget(loopId, principal)).toBe(agent);
    await pg.exec(`UPDATE kernel.loop_events SET issuer='did:imajin:other' WHERE type='loop.progress'`);
    await expect(resolveSessionCommandTarget(loopId, principal)).rejects.toThrow('Ambiguous');
  });
});

describe('signed socket bindings and outcomes', () => {
  it('persists verified binding, deduplicates reconnects and revalidates current keys', async () => {
    const frame = binding();
    expect(await ingestSessionCommandFrame(agent, frame)).toEqual({ accepted: true, duplicate: false });
    expect(await ingestSessionCommandFrame(agent, frame)).toEqual({ accepted: true, duplicate: true });
    expect(await getSessionBinding(principal, 'native-approval')).toEqual(frame.attestation.payload);
    expect(await getSessionBinding(principal, 'native-approval', 'did:imajin:foreign')).toBeNull();
    expect(await getSessionBinding('did:imajin:other', 'native-approval')).toBeNull();
    expect(await hasSessionBinding(principal, 'native-approval')).toBe(true);
    registry.set(agent, crypto.generateKeypair().publicKey);
    expect(await getSessionBinding(principal, 'native-approval')).toBeNull();
    expect(await hasSessionBinding(principal, 'native-approval')).toBe(true);
  });
  it('rejects forged socket DID, stale/tampered signatures and binding fields', async () => {
    await expect(ingestSessionCommandFrame('did:imajin:foreign', binding())).rejects.toThrow('Socket publisher');
    await expect(ingestSessionCommandFrame(agent, binding({ agentDid: 'did:imajin:foreign' }))).rejects.toThrow('publisher mismatch');
    await expect(ingestSessionCommandFrame(agent, binding({ additional: 'forbidden' }))).rejects.toThrow();
    const frame = binding();
    frame.attestation.signature = '0'.repeat(128);
    await expect(ingestSessionCommandFrame(agent, frame)).rejects.toThrow('Invalid current');
    const stale = binding();
    stale.attestation.timestamp = Date.now() - 600_000;
    await expect(ingestSessionCommandFrame(agent, stale)).rejects.toThrow('time window');
    await expect(ingestSessionCommandFrame(agent, { ...binding(), did: agent })).rejects.toThrow('Unexpected');
    await expect(ingestSessionCommandFrame(agent, null)).rejects.toThrow('Invalid or oversized');
    await expect(ingestSessionCommandFrame(agent, { data: 'x'.repeat(25_000) })).rejects.toThrow('oversized');
    await expect(ingestSessionCommandFrame(agent, { ...binding(), type: 'unknown' })).rejects.toThrow('Unsupported');
  });
  it('makes multiple valid bindings ambiguous instead of choosing convenient agent/loop', async () => {
    await ingestSessionCommandFrame(agent, binding());
    await pg.query(`INSERT INTO kernel.loops (loop_id,kind,principal,state) VALUES ('another','openclaw.session',$1,'running')`, [principal]);
    await lifecycle('loop.started', agent, 'another');
    await expect(ingestSessionCommandFrame(agent, binding({ loopId: 'another' }))).rejects.toThrow('Conflicting');
    expect(await getSessionBinding(principal, 'native-approval')).toBeNull();
  });
  it('does not count delivery as completion; persists only correlated signed result and dedups it', async () => {
    const frame = await signCommand();
    await dispatchSessionCommand(loopId, principal, frame);
    expect(await getSessionEvent('result', frame.commandId, principal)).toBeNull();
    const result = outcome(frame);
    expect(await ingestSessionCommandFrame(agent, result)).toEqual({ accepted: true, duplicate: false });
    expect(await ingestSessionCommandFrame(agent, result)).toEqual({ accepted: true, duplicate: true });
    const stored = await getSessionEvent('result', frame.commandId, principal);
    expect(stored?.payload.commandId).toBe(frame.commandId);
    expect(stored?.payload.attestation).toEqual(result.attestation);
    await expect(ingestSessionCommandFrame(agent, outcome(frame, { outcome: 'failed', eventType: 'loop.session.send.failed' }))).rejects.toThrow('Conflicting');
  });
  it.each([
    { commandId: 'unknown' }, { principal: 'did:imajin:foreign' }, { issuer: 'did:imajin:foreign' },
    { agentDid: 'did:imajin:foreign' }, { payloadHash: '0'.repeat(64) }, { command: 'session.abort' },
    { approvalId: 'unbound' }, { loopId: 'other' }, { childLoopId: 'untrusted' },
    { at: '2020-01-01T00:00:00.000Z' }, { at: new Date(Date.now() + 600_000).toISOString() },
  ])('rejects uncorrelated signed outcome %j', async extra => {
    const frame = await signCommand();
    await dispatchSessionCommand(loopId, principal, frame);
    await expect(ingestSessionCommandFrame(agent, outcome(frame, extra))).rejects.toThrow();
    expect(await getSessionEvent('result', frame.commandId, principal)).toBeNull();
  });
  it('rejects outcomes before any dispatch attempt and mismatched outer event type', async () => {
    const frame = await signCommand();
    await insertSessionCommand({ execute: mocks.execute } as never, loopId, frame);
    await expect(ingestSessionCommandFrame(agent, outcome(frame))).rejects.toThrow('not been dispatched');
    const result = outcome(frame);
    result.type = 'loop.session.send.failed';
    await expect(ingestSessionCommandFrame(agent, result)).rejects.toThrow('not correlated');
  });
  it('accepts signed failed rejection without invented loop identity', async () => {
    const frame = await signCommand();
    await dispatchSessionCommand(loopId, principal, frame);
    const result = outcome(frame, { outcome: 'failed', eventType: 'loop.session.send.failed', reason: 'loop_not_found', detail: 'Target unavailable' });
    delete (result.attestation.payload as Record<string, unknown>).loopId;
    result.attestation = envelope(result.attestation.payload);
    expect(await ingestSessionCommandFrame(agent, result)).toEqual({ accepted: true, duplicate: false });
  });
  it('projects only a signed correlated spawned child and makes it commandable with current proof', async () => {
    const frame = await signCommand('session.spawn', { parentLoopId: loopId, task: 'Investigate', model: 'model-a', group: 'blue' });
    await dispatchSessionCommand(loopId, principal, frame);
    const result = outcome(frame, { loopId: 'child', childLoopId: 'child', parentLoopId: loopId });
    await ingestSessionCommandFrame(agent, result);
    expect((await pg.query(`SELECT principal,parent_loop_id,kind,state FROM kernel.loops WHERE loop_id='child'`)).rows)
      .toEqual([{ principal, parent_loop_id: loopId, kind: 'openclaw.subagent', state: 'running' }]);
    expect(await resolveSessionCommandTarget('child', principal)).toBe(agent);
    await expect(ingestSessionCommandFrame(agent, outcome(frame, { loopId: 'child2', childLoopId: 'child2', parentLoopId: loopId }))).rejects.toThrow('Conflicting');
    expect((await pg.query(`SELECT loop_id FROM kernel.loops WHERE loop_id='child2'`)).rows).toEqual([]);
  });
  it('rolls back result when child ownership conflicts, and rejects invalid lineage', async () => {
    const frame = await signCommand('session.spawn', { parentLoopId: loopId, task: 'Investigate' });
    await dispatchSessionCommand(loopId, principal, frame);
    await expect(ingestSessionCommandFrame(agent, outcome(frame, { loopId: 'child', childLoopId: 'other', parentLoopId: loopId }))).rejects.toThrow('lineage');
    await pg.query(`INSERT INTO kernel.loops (loop_id,kind,principal,state) VALUES ('child','openclaw.session','did:imajin:other','running')`);
    await expect(ingestSessionCommandFrame(agent, outcome(frame, { loopId: 'child', childLoopId: 'child', parentLoopId: loopId }))).rejects.toThrow('lineage conflict');
    expect(await getSessionEvent('result', frame.commandId, principal)).toBeNull();
  });
  it('atomically chooses one conflicting concurrent spawn result and projects only its child', async () => {
    const frame = await signCommand('session.spawn', { parentLoopId: loopId, task: 'Investigate' });
    await dispatchSessionCommand(loopId, principal, frame);
    const results = await Promise.allSettled(['child-a', 'child-b'].map(child => ingestSessionCommandFrame(agent, outcome(frame, { loopId: child, childLoopId: child, parentLoopId: loopId }))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect((await pg.query(`SELECT loop_id FROM kernel.loops WHERE parent_loop_id=$1`, [loopId])).rows).toHaveLength(1);
  });
});
