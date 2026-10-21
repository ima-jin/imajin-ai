import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CONNECTION_REQUEST_SCOPE, deliverConnectionRequestEmail, sanitizeConnectionRequestData } from '../connection-request-email';

const { begin } = vi.hoisted(() => ({ begin: vi.fn() }));
vi.mock('@imajin/db', () => ({ getClient: () => ({ begin }) }));

const recipientDid = 'did:imajin:recipient';
const fromDid = 'did:imajin:sender';
const now = new Date('2026-01-02T12:00:00Z').getTime();
type Prior = { recipient: string; from: string; scope: string; channels: string[]; createdAt: number };
let prior: Prior[];
let queries: Array<{ sql: string; values: unknown[] }>;

/** Models DB locks/commits to exercise callback ordering, not a substitute for a live DB test. */
beforeEach(() => {
  vi.clearAllMocks();
  prior = [];
  queries = [];
  let pending = Promise.resolve();
  begin.mockImplementation(async (isolation, callback) => {
    expect(isolation).toBe('isolation level read committed');
    let unlock!: () => void;
    const previous = pending;
    pending = new Promise<void>((resolve) => { unlock = resolve; });
    let pair: string[];
    const tx = { unsafe: async (sql: string, values: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes('pg_advisory_xact_lock')) {
        await previous;
        pair = JSON.parse(values[0] as string);
        return [];
      }
      if (sql.includes('auth.credentials')) {
        expect(sql).toContain("type = 'email' AND verified_at IS NOT NULL");
        return [{ value: 'recipient@example.com' }];
      }
      if (sql.includes('SELECT 1 FROM notify.notifications')) {
        expect(sql).toContain("channels_sent @> ARRAY['email']::text[]");
        expect(sql).toContain("created_at > clock_timestamp() - interval '24 hours'");
        const [recipient, scope, sender] = values;
        return prior.filter((row) => row.recipient === recipient && row.from === sender && row.scope === scope && row.channels.includes('email') && row.createdAt > now - 86_400_000);
      }
      expect(sql).toContain('UPDATE notify.notifications');
      prior.push({ recipient: pair[1], from: pair[2], scope: pair[0], channels: ['email'], createdAt: now });
      return [];
    } };
    try { return await callback(tx); } finally { unlock(); }
  });
});

function send(overrides: Partial<Parameters<typeof deliverConnectionRequestEmail>[0]> = {}) {
  return deliverConnectionRequestEmail({
    recipientDid, fromDid, notificationId: 'ntf_request',
    deliver: async () => ({ delivered: true, emailResolved: true }), ...overrides,
  });
}

describe('connection request email quota', () => {
  it.each([
    [86_399_999, false],
    [86_400_000, true],
    [86_400_001, true],
  ])('prior success %i ms ago allows email: %s', async (age, allowed) => {
    prior.push({ recipient: recipientDid, from: fromDid, scope: CONNECTION_REQUEST_SCOPE, channels: ['email'], createdAt: now - age });
    const deliver = vi.fn(async () => ({ delivered: true, emailResolved: true }));
    await send({ deliver });
    expect(deliver).toHaveBeenCalledTimes(allowed ? 1 : 0);
  });

  it.each([
    { recipient: 'did:imajin:other' }, { from: 'did:imajin:other' },
    { scope: 'connection:accepted' }, { channels: ['inapp'] },
  ])('does not suppress for a different pair/scope or unsuccessful email: %j', async (override) => {
    prior.push({ recipient: recipientDid, from: fromDid, scope: CONNECTION_REQUEST_SCOPE, channels: ['email'], createdAt: now, ...override });
    const deliver = vi.fn(async () => ({ delivered: true, emailResolved: true }));
    await send({ deliver });
    expect(deliver).toHaveBeenCalledOnce();
  });

  it('holds the pair lock through send and success record so concurrent requests send once', async () => {
    const deliver = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { delivered: true, emailResolved: true };
    });
    await Promise.all([send({ deliver }), send({ deliver, notificationId: 'ntf_second' })]);
    expect(deliver).toHaveBeenCalledOnce();
    expect(prior).toHaveLength(1);
    expect(queries[0].values).toEqual([JSON.stringify([CONNECTION_REQUEST_SCOPE, recipientDid, fromDid])]);
  });

  it('does not consume quota on failure; a later request may succeed', async () => {
    await send({ deliver: async () => ({ delivered: false, emailResolved: true }) });
    expect(prior).toHaveLength(0);
    expect(await send()).toEqual({ delivered: true, emailResolved: true });
  });

  it.each([undefined, '', 123, 'not-a-did'])('skips email without a valid fromDid: %s', async (invalid) => {
    expect(await send({ fromDid: invalid })).toBeNull();
    expect(begin).not.toHaveBeenCalled();
  });

  it('preserves other scopes but strips connection payload email', () => {
    const data = { email: 'untrusted@example.com', fromDid };
    expect(sanitizeConnectionRequestData('legacy', data)).toBe(data);
    expect(sanitizeConnectionRequestData(CONNECTION_REQUEST_SCOPE, data)).toEqual({ fromDid });
  });
});
