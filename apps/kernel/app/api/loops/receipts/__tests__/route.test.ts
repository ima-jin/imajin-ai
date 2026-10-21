import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { canonicalize, crypto as authCrypto, SIGNED_MESSAGE_MAX_AGE, FUTURE_TOLERANCE } from '@imajin/auth';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BusEvent } from '@imajin/bus';
import type { LoopIngestRequest, LoopRailType } from '@/src/lib/loops/types';
import type { LoopReceiptRequest } from '@/src/lib/loops/receipt-types';

const { sql, publish, keys, grant, logger } = vi.hoisted(() => ({
  sql: vi.fn(), publish: vi.fn(), keys: new Map<string, string>(), grant: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock('@imajin/db', () => ({ getClient: () => sql }));
vi.mock('@imajin/bus', () => ({ publish }));
vi.mock('@imajin/logger', () => ({ createLogger: () => logger }));
vi.mock('@/src/db', () => ({ db: {}, identities: {} }));
vi.mock('@imajin/auth/resolve-db', () => ({
  createDbResolver: () => async (did: string) => keys.has(did) ? { publicKey: keys.get(did) } : null,
}));
vi.mock('@/src/lib/vault/sealing', () => ({
  getNodeSigningIdentity: () => ({ senderDid: 'did:imajin:node' }),
}));
vi.mock('@/src/lib/auth/grants', () => ({ introspectGrant: grant }));
vi.mock('@/src/lib/kernel/cors', () => ({
  corsHeaders: () => ({ 'access-control-allow-origin': '*' }),
  corsOptions: () => new Response(null, { status: 204 }),
}));

import { POST, OPTIONS } from '../route';
import { POST as ingest } from '../../route';
import { loopObservationId } from '@/src/lib/loops/surface-lease';
import { loopProjectionReactor } from '../../../../../../../packages/bus/src/reactors/loop-projection';
import { CODE_STEP } from '@/src/lib/loops/__tests__/horizon-fixtures';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
const publisher = 'did:imajin:publisher';
const other = 'did:imajin:other';
const principal = 'did:imajin:owner';
const pair = authCrypto.generateKeypair();
const otherPair = authCrypto.generateKeypair();
const now = Date.now();
let pg: PGlite;

function tagged(connection: Pick<PGlite, 'query'>) {
  return async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.reduce((result, part, i) => result + (i ? `$${i}` : '') + part, '');
    // PGlite is single-connection; state-changing SQL runs unmodified.
    if (text.includes('pg_advisory_xact_lock')) return [];
    return (await connection.query(text, values)).rows;
  };
}
function reconnect() {
  sql.mockImplementation(tagged(pg));
  Object.assign(sql, { begin: (work: (tx: ReturnType<typeof tagged>) => Promise<unknown>) => pg.transaction(tx => work(tagged(tx))) });
}
function sign<T extends { type: string; payload: object }>(fields: T, did = publisher) {
  const key = did === publisher ? pair : otherPair;
  return {
    ...fields, publisherDid: did,
    signature: { keyId: key.publicKey, alg: 'ed25519' as const, sig: authCrypto.signSync(canonicalize(fields), key.privateKey) },
  };
}
function envelope(type: LoopRailType = 'loop.started', extra: Record<string, unknown> = {}): LoopIngestRequest {
  return sign({
    type, payload: {
      loopId: 'cycle', kind: 'cycle', principal, state: 'queued', summary: type,
      at: new Date(now).toISOString(), ...extra,
    },
  });
}
function receipt(event: LoopIngestRequest, overrides: Partial<LoopReceiptRequest['payload']> = {}, did = publisher): LoopReceiptRequest {
  return sign({
    type: 'loop.receipt' as const,
    payload: {
      loopId: event.payload.loopId, principal: event.payload.principal,
      envelopeHash: loopObservationId(event).slice('signed-loop:'.length), at: new Date(Date.now()).toISOString(), ...overrides,
    },
  }, did);
}
function http(body: unknown, path = 'receipts') {
  return new Request(`https://test.imajin.ai/api/loops/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }) as Parameters<typeof POST>[0];
}
async function ingestEvent(event: LoopIngestRequest) {
  expect((await ingest(http(event, ''))).status).toBe(201);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE SCHEMA kernel;
    CREATE TABLE kernel.bus_chain_configs (event_type text, scope text, reactors jsonb, enabled boolean, updated_at timestamptz,
      UNIQUE(event_type, scope));`);
  await pg.exec(readFileSync(new URL('../../../../../../../migrations/archive/pre-kernel-baseline/0157_loops_rail.sql', import.meta.url), 'utf8'));
  await pg.exec(readFileSync(new URL('../../../../../../../migrations/archive/pre-kernel-baseline/0194_surface_lease.sql', import.meta.url), 'utf8'));
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('No upstream calls permitted')));
  keys.set(publisher, pair.publicKey);
  keys.set(other, otherPair.publicKey);
  grant.mockResolvedValue({ authorized: true });
  reconnect();
  publish.mockImplementation((type: string, event: Omit<BusEvent, 'type'>) => loopProjectionReactor({ ...event, type }, {}));
  await pg.exec('TRUNCATE kernel.loops, kernel.loop_events, kernel.surface_lease');
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
afterAll(() => pg.close());

describe('signed envelope receipt HTTP reconciliation', () => {
  it('reconciles an ambiguously accepted stale envelope after restart without restamping or duplicating history', async () => {
    await ingestEvent(envelope());
    const event = envelope('step.queued', { stepId: 'next', step: CODE_STEP });
    const exactOutbox = JSON.stringify(event);
    await ingestEvent(event); // Simulate a lost HTTP response after durable acceptance.
    await ingestEvent(event); // An exact fresh retry also keeps one history row.
    vi.mocked(Date.now).mockReturnValue(now + SIGNED_MESSAGE_MAX_AGE + 1);
    reconnect(); // Drop the client state; durable history alone answers the lookup.
    const recovered: LoopIngestRequest = JSON.parse(exactOutbox);
    const response = await POST(http(receipt(recovered)));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ status: 'accepted', eventId: loopObservationId(event) });
    expect((await ingest(http(recovered, ''))).status).toBe(400);
    expect(JSON.stringify(recovered)).toBe(exactOutbox);
    const history = await pg.query('SELECT id FROM kernel.loop_events WHERE type = $1', ['step.queued']);
    expect(history.rows).toEqual([{ id: loopObservationId(event) }]);
    expect(publish).toHaveBeenCalledTimes(3); // Lookup and rejected stale retry never publish.
  });

  it('returns identical not-found for unknown, another publisher, another loop, and another principal', async () => {
    const event = envelope();
    await ingestEvent(event);
    const queries = [
      receipt(event, { envelopeHash: '0'.repeat(64) }),
      receipt(event, {}, other), // Even a delegate of the same principal cannot see this publisher's receipt.
      receipt(event, { loopId: 'another-loop' }),
      receipt(event, { principal: other }),
    ];
    for (const query of queries) {
      const response = await POST(http(query));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ status: 'not_found' });
    }
    grant.mockResolvedValueOnce({ authorized: false }); // Revoked delegation is non-disclosing too.
    const denied = await POST(http(receipt(event)));
    expect(denied.status).toBe(404);
    expect(await denied.json()).toEqual({ status: 'not_found' });
  });

  it('rejects an unseen stale envelope while its fresh signed receipt lookup returns not-found', async () => {
    const unseen = envelope();
    vi.mocked(Date.now).mockReturnValue(now + SIGNED_MESSAGE_MAX_AGE + 1);
    const response = await ingest(http(unseen, ''));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'payload.at is outside the accepted clock-skew window' });
    const lookup = await POST(http(receipt(unseen)));
    expect(lookup.status).toBe(404);
    expect(await lookup.json()).toEqual({ status: 'not_found' });
    expect((await pg.query('SELECT id FROM kernel.loop_events')).rows).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
  });

  it.each(['loop.started', 'loop.progress', 'loop.blocked', 'loop.finished'] as const)('retains one stored receipt for exact fresh %s retries', async type => {
    const event = envelope(type);
    await ingestEvent(event);
    await ingestEvent(event);
    const response = await POST(http(receipt(event)));
    expect(await response.json()).toEqual({ status: 'accepted', eventId: loopObservationId(event) });
    expect((await pg.query('SELECT id FROM kernel.loop_events')).rows).toEqual([{ id: loopObservationId(event) }]);
  });

  it('accepts an independently computed client hash with normalized signature hex, not HTTP bytes', async () => {
    const original = envelope();
    const upper = {
      ...original,
      signature: { ...original.signature, keyId: original.signature.keyId.toUpperCase(), sig: original.signature.sig.toUpperCase() },
    };
    await ingestEvent(upper);
    const envelopeHash = createHash('sha256').update(canonicalize(original), 'utf8').digest('hex');
    const response = await POST(http(receipt(original, { envelopeHash })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'accepted', eventId: `signed-loop:${envelopeHash}` });
    const httpHash = createHash('sha256').update(JSON.stringify(upper, null, 2)).digest('hex');
    const absent = await POST(http(receipt(original, { envelopeHash: httpHash })));
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ status: 'not_found' });
  });

  it('does not return orphaned history or history whose loop no longer belongs to its principal', async () => {
    const event = envelope();
    await ingestEvent(event);
    await pg.query('UPDATE kernel.loops SET principal = $1 WHERE loop_id = $2', [other, event.payload.loopId]);
    const changedOwner = await POST(http(receipt(event)));
    expect(changedOwner.status).toBe(404);
    expect(await changedOwner.json()).toEqual({ status: 'not_found' });
    await pg.query('DELETE FROM kernel.loops WHERE loop_id = $1', [event.payload.loopId]);
    const deletedOwner = await POST(http(receipt(event)));
    expect(deletedOwner.status).toBe(404);
    expect(await deletedOwner.json()).toEqual({ status: 'not_found' });
  });

  it('finds a signed surface receipt without re-acquiring or renewing its lease', async () => {
    await ingestEvent(envelope());
    const event = envelope('surface.acquired', { surface: 'issue:#2931' });
    await ingestEvent(event);
    vi.mocked(Date.now).mockReturnValue(now + SIGNED_MESSAGE_MAX_AGE + 1);
    const response = await POST(http(receipt(event)));
    expect(await response.json()).toEqual({ status: 'accepted', eventId: loopObservationId(event) });
    const lease = await pg.query<{ acquired_at: Date }>('SELECT acquired_at FROM kernel.surface_lease');
    expect(new Date(lease.rows[0].acquired_at).getTime()).toBe(now);
  });

  it('verifies signatures over type, loop, principal, hash and lookup timestamp before querying history', async () => {
    const original = receipt(envelope());
    const tampered = [
      { ...original, signature: { ...original.signature, sig: '0'.repeat(128) } },
      { ...original, payload: { ...original.payload, loopId: 'other' } },
      { ...original, payload: { ...original.payload, principal: other } },
      { ...original, payload: { ...original.payload, envelopeHash: '0'.repeat(64) } },
      { ...original, payload: { ...original.payload, at: new Date(now - 1).toISOString() } },
      sign({ type: 'loop.progress', payload: original.payload }),
    ];
    for (const body of tampered) {
      const response = await POST(http(body));
      expect(response.status).toBe(400);
    }
    expect(sql).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
  });

  it('rejects unknown and rotated publisher keys without revealing receipts', async () => {
    const query = receipt(envelope());
    keys.delete(publisher);
    expect((await POST(http(query))).status).toBe(400);
    keys.set(publisher, otherPair.publicKey);
    expect((await POST(http(query))).status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });

  it('sanitizes database failures and never reports them as not-found', async () => {
    sql.mockRejectedValueOnce(new Error('driver parameters must remain private'));
    const response = await POST(http(receipt(envelope())));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to look up loop receipt' });
    expect(logger.error).toHaveBeenCalledWith({}, 'loop receipt lookup failed');
  });

  it('fails closed without exposing authorization storage failures', async () => {
    grant.mockRejectedValueOnce(new Error('private grant storage parameters'));
    const response = await POST(http(receipt(envelope())));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'Failed to look up loop receipt' });
    expect(sql).not.toHaveBeenCalled();
  });
});

describe('receipt request boundary', () => {
  it('serves CORS preflight', async () => {
    expect((await OPTIONS(http(null))).status).toBe(204);
  });
  it.each([
    null, [], {}, { type: 'loop.receipt' },
  ])('rejects malformed request %#', async body => {
    expect((await POST(http(body))).status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
  it.each([
    { envelopeHash: 'not-a-hash' }, { envelopeHash: 'A'.repeat(64) }, { loopId: '' },
    { principal: 'not-a-did' }, { at: 'not-a-date' }, { extra: true },
    { at: new Date(now - SIGNED_MESSAGE_MAX_AGE - 1).toISOString() },
    { at: new Date(now + FUTURE_TOLERANCE + 1).toISOString() },
  ])('rejects invalid or stale lookup fields %#', async overrides => {
    const body = receipt(envelope());
    expect((await POST(http({ ...body, payload: { ...body.payload, ...overrides } }))).status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
  it.each([
    { keyId: 'bad' }, { alg: 'rsa' }, { sig: 'bad' },
  ])('rejects malformed signature %#', async overrides => {
    const body = receipt(envelope());
    expect((await POST(http({ ...body, signature: { ...body.signature, ...overrides } }))).status).toBe(400);
    expect(sql).not.toHaveBeenCalled();
  });
  it('rejects invalid JSON and oversized bodies without querying history', async () => {
    const invalid = new Request('https://test.imajin.ai/api/loops/receipts', { method: 'POST', body: '{' });
    expect((await POST(invalid as Parameters<typeof POST>[0])).status).toBe(400);
    expect((await POST(http({ padding: 'x'.repeat(1024 * 1024) }))).status).toBe(413);
    expect(sql).not.toHaveBeenCalled();
  });
});
