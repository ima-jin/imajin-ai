/**
 * The `mjn` reactor (#2016, #2017):
 *  - executes `unit: 'MJNx'` in-process with no HTTP or shared key;
 *  - takes recipients/amounts from the live `kernel.bus_chain_configs` row, so
 *    editing the row changes the very next emission (no code, no cache);
 *  - stamps every emission with the attestation id and the (config row id,
 *    version) that produced it;
 *  - is idempotent + retrying: every attempt carries the same
 *    `idempotency_key`, transient failures are retried, and a lost emission
 *    makes the reactor throw instead of failing silently.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { BusEvent } from '../src/types';

interface FakeRow {
  id: string;
  event_type: string;
  scope: string | null;
  version: number;
  enabled: boolean;
  reactors: unknown;
}

const { db, fakeSql } = vi.hoisted(() => {
  const db = { rows: [] as FakeRow[] };
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ? ');
    const [eventType, scope] = values;
    const wantsNullScope = text.includes('scope IS NULL');
    const matches = db.rows.filter(
      (r) => r.event_type === eventType && (wantsNullScope ? r.scope === null : r.scope === scope),
    );
    return Promise.resolve(matches.slice(0, 1));
  };
  return { db, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

function makeEvent(overrides: Partial<BusEvent> = {}): BusEvent {
  return {
    type: 'identity.created',
    issuer: 'did:imajin:issuer',
    subject: 'did:imajin:subject',
    scope: 'auth',
    payload: { attestationId: 'att_1' },
    ...overrides,
  };
}

function mjnRow(overrides: Partial<FakeRow> & { emit?: unknown[]; config?: Record<string, unknown> } = {}): FakeRow {
  const { emit, config, ...rest } = overrides;
  return {
    id: 'cfg_1',
    event_type: 'identity.created',
    scope: null,
    version: 1,
    enabled: true,
    reactors: [
      { type: 'attestation', config: { attestationType: 'identity.created' }, await: true, enabled: true },
      {
        type: 'mjn',
        enabled: true,
        config: {
          attestationType: 'identity.created',
          unit: 'MJNx',
          emit: emit ?? [{ to: 'subject', amount: 10, reason: 'Welcome' }],
          retryDelayMs: 0,
          ...config,
        },
      },
    ],
    ...rest,
  };
}

const executorMock = vi.fn();
const fetchMock = vi.fn();

function okResponse() {
  return { id: 'tx_1', amount: '10', to_did: 'did:imajin:subject', status: 'completed' };
}

function failResponse(status: number) {
  return { error: `status ${status}`, status };
}

interface PostedBody {
  to_did: string;
  amount: number;
  unit: string;
  reason: string;
  currency?: string;
  metadata: Record<string, unknown>;
}

function postedBodies(): PostedBody[] {
  return executorMock.mock.calls.map(([body]) => body as PostedBody);
}

async function runReactor(event: BusEvent, config: Record<string, unknown> = { attestationType: 'identity.created' }) {
  const { mjnReactor } = await import('../src/reactors/mjn');
  return mjnReactor(event, config);
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  vi.stubGlobal('fetch', fetchMock);
  executorMock.mockReset();
  executorMock.mockResolvedValue(okResponse());
  db.rows = [mjnRow()];
  vi.stubEnv('PAY_SERVICE_URL', '');
  vi.stubEnv('PAY_SERVICE_API_KEY', '');
  const { registerEmissionExecutor } = await import('../src/reactors/mjn');
  registerEmissionExecutor(executorMock);
});

afterEach(async () => {
  const { registerEmissionExecutor } = await import('../src/reactors/mjn');
  registerEmissionExecutor(null);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('mjnReactor — unit MJNx, amounts from the config row', () => {
  it('executes unit: MJNx without HTTP or shared credentials with the amount/recipient/reason from the bus_chain_configs row', async () => {
    await runReactor(makeEvent());

    expect(executorMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    const body = postedBodies()[0];
    expect(body).toMatchObject({ to_did: 'did:imajin:subject', amount: 10, unit: 'MJNx', reason: 'Welcome' });
    expect(body.currency).toBeUndefined();
  });

  it('changing the config row changes the next emission', async () => {
    await runReactor(makeEvent({ payload: { attestationId: 'att_1' } }));
    expect(postedBodies()[0]).toMatchObject({ amount: 10 });

    // Operator edits the row: new amount, new recipient, version bumped by the DB trigger.
    db.rows = [mjnRow({ version: 2, emit: [{ to: 'issuer', amount: 25, reason: 'Retuned' }] })];
    executorMock.mockClear();
    await runReactor(makeEvent({ payload: { attestationId: 'att_2' } }));

    expect(postedBodies()[0]).toMatchObject({
      to_did: 'did:imajin:issuer',
      amount: 25,
      reason: 'Retuned',
      metadata: { emission_config_version: 2 },
    });
  });

  it('resolves a percent rule against the settlement value (cents → MJNx)', async () => {
    db.rows = [
      mjnRow({
        event_type: 'ticket.purchased',
        emit: [
          { to: 'subject', percent: 0.25, reason: 'Ticket purchase reward' },
          { to: 'issuer', percent: 0.25, reason: 'Ticket sale reward' },
        ],
        config: { attestationType: 'ticket.purchased' },
      }),
    ];
    await runReactor(
      makeEvent({ type: 'ticket.purchased', payload: { attestationId: 'att_t', amount: 1000 } }),
      { attestationType: 'ticket.purchased' },
    );

    // 0.25% of $10.00 = $0.025 = 2.5 MJNx, to each side
    expect(postedBodies().map((b) => [b.to_did, b.amount])).toEqual([
      ['did:imajin:subject', 2.5],
      ['did:imajin:issuer', 2.5],
    ]);
  });

  it('prefers a scoped row over the node-default row', async () => {
    db.rows = [
      mjnRow({ id: 'cfg_default', scope: null }),
      mjnRow({ id: 'cfg_scoped', scope: 'auth', emit: [{ to: 'subject', amount: 99, reason: 'Scoped' }] }),
    ];
    await runReactor(makeEvent());

    expect(postedBodies()[0]).toMatchObject({ amount: 99, metadata: { emission_config_id: 'cfg_scoped' } });
  });

  it.each([
    ['there is no chain row', () => []],
    ['the row is disabled', () => [mjnRow({ enabled: false })]],
    ['the mjn entry is disabled', () => [{ ...mjnRow(), reactors: [{ type: 'mjn', enabled: false, config: { emit: [] } }] }]],
    ['the row has no mjn entry', () => [{ ...mjnRow(), reactors: [{ type: 'emit', config: {}, enabled: true }] }]],
    ['the mjn entry is for a different attestation type', () => [mjnRow({ config: { attestationType: 'vouch' } })]],
    ['the schedule is empty', () => [mjnRow({ emit: [] })]],
  ])('emits nothing when %s', async (_name, rows) => {
    db.rows = rows();
    await runReactor(makeEvent());
    expect(executorMock).not.toHaveBeenCalled();
  });

  it('skips a rule with no resolvable target and a rule that resolves to zero', async () => {
    db.rows = [
      mjnRow({
        emit: [
          { to: 'scope', amount: 1, reason: 'No scope DID on the event' },
          { to: 'node', amount: 1, reason: 'Node DID is never resolved' },
          { to: 'subject', percent: 0.25, reason: 'No settlement value → 0' },
          { to: 'issuer', amount: 0, reason: 'Operator-disabled slot' },
          { to: 'subject', amount: 3, reason: 'Real one' },
        ],
      }),
    ];
    await runReactor(makeEvent());

    expect(postedBodies().map((b) => b.reason)).toEqual(['Real one']);
  });

  it('resolves a scope recipient from payload.scope_did', async () => {
    db.rows = [mjnRow({ emit: [{ to: 'scope', amount: 1, reason: 'Onboarded' }] })];
    await runReactor(makeEvent({ payload: { attestationId: 'att_1', scope_did: 'did:imajin:scope' } }));
    expect(postedBodies()[0].to_did).toBe('did:imajin:scope');
  });

  it('fails visibly when no in-process executor is registered', async () => {
    const { registerEmissionExecutor } = await import('../src/reactors/mjn');
    registerEmissionExecutor(null);
    await expect(runReactor(makeEvent())).rejects.toThrow(/no in-process emission executor/);
    expect(executorMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a malformed schedule instead of silently emitting nothing', async () => {
    db.rows = [mjnRow({ emit: [{ to: 'subject', amount: 1, percent: 1, reason: 'Both set' }] })];
    await expect(runReactor(makeEvent())).rejects.toThrow(/exactly one of amount \| percent/);
    expect(executorMock).not.toHaveBeenCalled();
  });
});

describe('mjnReactor — provenance (attestation id + config version)', () => {
  it('records the triggering attestation id and the config row id + version on the emission', async () => {
    db.rows = [mjnRow({ id: 'cfg_prov', version: 7 })];
    await runReactor(makeEvent({ payload: { attestationId: 'att_from_reactor' } }));

    expect(postedBodies()[0].metadata).toMatchObject({
      attestation_id: 'att_from_reactor',
      attestation_type: 'identity.created',
      emission_config_id: 'cfg_prov',
      emission_config_version: 7,
      to_role: 'subject',
      event_type: 'identity.created',
      issuer: 'did:imajin:issuer',
      subject: 'did:imajin:subject',
    });
  });

  it('refuses an untraceable emission: no attestation id → throws, nothing is credited', async () => {
    await expect(runReactor(makeEvent({ payload: {} }))).rejects.toThrow(/no attestation id/);
    expect(executorMock).not.toHaveBeenCalled();
  });
});

describe('mjnReactor — idempotent retry; a lost emission is visible', () => {
  it('derives a stable idempotency key per (attestation, rule slot, recipient)', async () => {
    db.rows = [
      mjnRow({
        emit: [
          { to: 'subject', amount: 1, reason: 'a' },
          { to: 'issuer', amount: 1, reason: 'b' },
        ],
      }),
    ];
    await runReactor(makeEvent({ payload: { attestationId: 'att_k' } }));

    expect(postedBodies().map((b) => b.metadata.idempotency_key)).toEqual([
      'emission:att_k:0:subject',
      'emission:att_k:1:issuer',
    ]);
  });

  it('retries a 5xx with the SAME idempotency key and succeeds without throwing', async () => {
    executorMock.mockResolvedValueOnce(failResponse(503)).mockResolvedValueOnce(okResponse());

    await expect(runReactor(makeEvent())).resolves.toBeUndefined();

    expect(executorMock).toHaveBeenCalledTimes(2);
    const [first, second] = postedBodies();
    expect(first.metadata.idempotency_key).toBe('emission:att_1:0:subject');
    expect(second).toEqual(first);
  });

  it('retries a thrown error and a 429', async () => {
    executorMock
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(failResponse(429))
      .mockResolvedValueOnce(okResponse());

    await expect(runReactor(makeEvent())).resolves.toBeUndefined();
    expect(executorMock).toHaveBeenCalledTimes(3);
  });

  it('throws once retries are exhausted, naming the attestation, config version and cause', async () => {
    db.rows = [mjnRow({ id: 'cfg_lost', version: 3 })];
    executorMock.mockResolvedValue(failResponse(500));

    await expect(runReactor(makeEvent({ payload: { attestationId: 'att_lost' } }))).rejects.toThrow(
      /1\/1 emission\(s\) lost.*att_lost.*cfg_lost v3.*500/,
    );
    expect(executorMock).toHaveBeenCalledTimes(3); // default max attempts
  });

  it('honours maxAttempts from the row config', async () => {
    db.rows = [mjnRow({ config: { maxAttempts: 2 } })];
    executorMock.mockRejectedValue(new Error('down'));

    await expect(runReactor(makeEvent())).rejects.toThrow(/lost/);
    expect(executorMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to the default attempt count for an invalid maxAttempts', async () => {
    db.rows = [mjnRow({ config: { maxAttempts: 'many', retryDelayMs: -5 } })];
    executorMock.mockResolvedValue(failResponse(502));

    await expect(runReactor(makeEvent())).rejects.toThrow(/lost/);
    expect(executorMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry a 4xx — retrying cannot fix the caller', async () => {
    executorMock.mockResolvedValue(failResponse(400));

    await expect(runReactor(makeEvent())).rejects.toThrow(/400/);
    expect(executorMock).toHaveBeenCalledTimes(1);
  });

  it('one lost rule does not stop the others; the reactor still throws', async () => {
    db.rows = [
      mjnRow({
        config: { maxAttempts: 1 },
        emit: [
          { to: 'subject', amount: 1, reason: 'first' },
          { to: 'issuer', amount: 1, reason: 'second' },
        ],
      }),
    ];
    executorMock.mockResolvedValueOnce(failResponse(500)).mockResolvedValueOnce(okResponse());

    await expect(runReactor(makeEvent())).rejects.toThrow(/1\/2 emission\(s\) lost/);
    expect(postedBodies().map((b) => b.reason)).toEqual(['first', 'second']);
  });

  it('re-publishing the same event re-sends the same keys, so the kernel ledger can dedupe', async () => {
    await runReactor(makeEvent());
    await runReactor(makeEvent());

    const keys = postedBodies().map((b) => b.metadata.idempotency_key);
    expect(keys).toEqual(['emission:att_1:0:subject', 'emission:att_1:0:subject']);
  });

  it('shares the registration across module copies via globalThis', async () => {
    vi.resetModules();
    const { getEmissionExecutor } = await import('../src/reactors/mjn');
    expect(getEmissionExecutor()).toBe(executorMock);
  });
});
