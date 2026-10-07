/**
 * Tests for the emit-allowlist helpers (#2638 / #2641): pure validation in
 * `emittable-events.ts` and the active-app DB lookup in `app-emittable-events.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  limitMock: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({ createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }) }));
vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));
vi.mock('@/src/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: mocks.limitMock }) }) }),
  },
  registryApps: { status: 'registryApps.status', emittableEvents: 'registryApps.emittableEvents', appDid: 'registryApps.appDid' },
}));

import {
  EVENTS_API_AUDIENCES,
  KERNEL_EVENT_NAMESPACES,
  MAX_EMITTABLE_EVENTS,
  hasEventsApiAudience,
  isKernelEventType,
  isValidEventType,
  readEmittableEvents,
  validateEmittableEvents,
} from '../emittable-events';
import { resolveEmittableEvents } from '../app-emittable-events';

describe('isValidEventType', () => {
  it.each(['tip.granted', 'tip.sent', 'listing.purchased', 'warp.run.still_running', 'vouch', 'a1.b2'])('accepts %s', (value) => {
    expect(isValidEventType(value)).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['uppercase', 'Tip.Granted'],
    ['a wildcard', 'tip.*'],
    ['a bare star', '*'],
    ['a leading dot', '.tip'],
    ['a trailing dot', 'tip.'],
    ['a double dot', 'tip..granted'],
    ['whitespace', 'tip granted'],
    ['a leading digit', '1tip'],
    ['a dash', 'tip-granted'],
    ['a slash', 'tip/granted'],
    ['over the length cap', `a.${'b'.repeat(120)}`],
    ['a number', 7],
    ['null', null],
    ['an object', {}],
  ])('rejects %s', (_label, value) => {
    expect(isValidEventType(value)).toBe(false);
  });
});

describe('validateEmittableEvents', () => {
  it('treats an absent list as "none declared"', () => {
    expect(validateEmittableEvents(undefined)).toEqual({ ok: [] });
    expect(validateEmittableEvents(null)).toEqual({ ok: [] });
  });

  it('accepts the empty list', () => {
    expect(validateEmittableEvents([])).toEqual({ ok: [] });
  });

  it('de-duplicates and sorts, so equal grants are byte-identical', () => {
    expect(validateEmittableEvents(['tip.sent', 'tip.granted', 'tip.sent'])).toEqual({ ok: ['tip.granted', 'tip.sent'] });
  });

  it('rejects a non-array', () => {
    expect(validateEmittableEvents('tip.granted')).toEqual({ error: expect.stringContaining('must be an array') });
    expect(validateEmittableEvents({ 0: 'tip.granted' })).toEqual({ error: expect.stringContaining('must be an array') });
  });

  it.each([
    ['a wildcard', ['tip.*']],
    ['an uppercase type', ['Tip.Granted']],
    ['a non-string', [7]],
    ['one bad entry among good ones', ['tip.granted', 'nope!']],
  ])('rejects %s, naming it', (_label, input) => {
    const result = validateEmittableEvents(input);
    expect(result).toEqual({ error: expect.stringContaining('emittableEvents entries must be lowercase dotted event types') });
  });

  it('caps the list length', () => {
    const tooMany = Array.from({ length: MAX_EMITTABLE_EVENTS + 1 }, (_v, i) => `evt.n${i}`);
    expect(validateEmittableEvents(tooMany)).toEqual({ error: expect.stringContaining('at most') });
    expect(validateEmittableEvents(tooMany.slice(1))).toEqual({ ok: expect.any(Array) });
  });
});

describe('readEmittableEvents', () => {
  it('returns well-formed entries and drops anything malformed (fail closed)', () => {
    expect(readEmittableEvents(['tip.granted', 'Bad!', 7, 'tip.sent'])).toEqual(['tip.granted', 'tip.sent']);
  });

  it.each([undefined, null, 'tip.granted', {}, 7])('approves nothing for the non-array %j', (value) => {
    expect(readEmittableEvents(value)).toEqual([]);
  });
});

describe('resolveEmittableEvents', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the approved list of an active app', async () => {
    mocks.limitMock.mockResolvedValue([{ status: 'active', emittableEvents: ['tip.granted'] }]);

    expect(await resolveEmittableEvents('did:imajin:app')).toEqual(['tip.granted']);
  });

  it('returns the empty list for an active app that was never approved for anything (the default)', async () => {
    mocks.limitMock.mockResolvedValue([{ status: 'active', emittableEvents: [] }]);

    expect(await resolveEmittableEvents('did:imajin:app')).toEqual([]);
  });

  it('returns null for a revoked app', async () => {
    mocks.limitMock.mockResolvedValue([{ status: 'revoked', emittableEvents: ['tip.granted'] }]);

    expect(await resolveEmittableEvents('did:imajin:app')).toBeNull();
  });

  it('returns null for an unknown app', async () => {
    mocks.limitMock.mockResolvedValue([]);

    expect(await resolveEmittableEvents('did:imajin:nobody')).toBeNull();
  });

  it('fails closed (null) when the lookup throws', async () => {
    mocks.limitMock.mockRejectedValue(new Error('db down'));

    expect(await resolveEmittableEvents('did:imajin:app')).toBeNull();
  });

  it('reads a malformed stored value as approving nothing', async () => {
    mocks.limitMock.mockResolvedValue([{ status: 'active', emittableEvents: 'tip.granted' }]);

    expect(await resolveEmittableEvents('did:imajin:app')).toEqual([]);
  });
});

describe('kernel-owned namespaces (#2717)', () => {
  it.each(['payment_request.paid', 'payment_request.created', 'loop.completed', 'attestation.created', 'identity.verified.hard', 'vault.secret_read', 'settlement.completed', 'order.paid', 'mjn'])(
    'treats %s as kernel-owned',
    (type) => {
      expect(isKernelEventType(type)).toBe(true);
    },
  );

  it.each(['tip.granted', 'tip.sent', 'listing.purchased', 'ticket.sold', 'coffee.tip_granted', 'loopback.ping', 'payment_requests.x'])(
    'leaves %s to apps',
    (type) => {
      expect(isKernelEventType(type)).toBe(false);
    },
  );

  it('matches on the first dotted segment only, never a prefix of it', () => {
    expect(isKernelEventType('loops.x')).toBe(false);
    expect(isKernelEventType('loop.x')).toBe(true);
  });

  it('every namespace in the denylist is itself a valid event-type segment', () => {
    for (const ns of KERNEL_EVENT_NAMESPACES) expect(isValidEventType(ns)).toBe(true);
  });

  it('validateEmittableEvents refuses a list containing a kernel-owned type and names it', () => {
    const result = validateEmittableEvents(['tip.granted', 'payment_request.paid', 'loop.started']);

    expect(result).toEqual({ error: expect.stringContaining('payment_request.paid, loop.started') });
  });

  it('validateEmittableEvents still accepts an app-domain list', () => {
    expect(validateEmittableEvents(['tip.sent', 'tip.granted'])).toEqual({ ok: ['tip.granted', 'tip.sent'] });
  });
});

describe('hasEventsApiAudience (#2717)', () => {
  it.each(EVENTS_API_AUDIENCES)('accepts the %s audience, alone or among others', (aud) => {
    expect(hasEventsApiAudience(aud)).toBe(true);
    expect(hasEventsApiAudience(['market', aud])).toBe(true);
  });

  it.each([
    ['another app slug', 'market'],
    ['a host', 'jin.imajin.ai'],
    ['an array of other audiences', ['market', 'coffee']],
    ['an empty string', ''],
    ['a missing aud', undefined],
    ['a non-string aud', 7],
  ])('rejects %s', (_label, aud) => {
    expect(hasEventsApiAudience(aud)).toBe(false);
  });
});
