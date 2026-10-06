/**
 * Emission schedule as configuration (#2017): parsing/validation of a `mjn`
 * reactor config's `emit[]`, amount/target resolution, and the acceptance
 * guard that the code DEFAULTS carry no amounts (the schedule lives only in
 * `kernel.bus_chain_configs` rows).
 */
import { describe, it, expect, vi } from 'vitest';

const { db, fakeSql } = vi.hoisted(() => {
  const db = { rows: [] as Array<Record<string, unknown>> };
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join(' ? ');
    const [eventType, scope] = values;
    const wantsNullScope = text.includes('scope IS NULL');
    return Promise.resolve(
      db.rows.filter((r) => r.event_type === eventType && (wantsNullScope ? r.scope === null : r.scope === scope)),
    );
  };
  return { db, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import { getChainConfig } from '../src/config';
import {
  EMISSION_UNIT,
  loadEmissionConfig,
  parseEmissionRules,
  resolveAmount,
  resolveTarget,
} from '../src/emissions';

describe('parseEmissionRules', () => {
  it('parses fixed-amount and percent rules', () => {
    expect(
      parseEmissionRules({
        unit: 'MJNx',
        emit: [
          { to: 'subject', amount: 1, reason: 'a' },
          { to: 'issuer', percent: 0.25, reason: 'b' },
        ],
      }),
    ).toEqual([
      { to: 'subject', amount: 1, reason: 'a' },
      { to: 'issuer', percent: 0.25, reason: 'b' },
    ]);
  });

  it('defaults the unit to MJNx when omitted', () => {
    expect(EMISSION_UNIT).toBe('MJNx');
    expect(parseEmissionRules({ emit: [{ to: 'node', amount: 0, reason: 'zero is allowed' }] })).toHaveLength(1);
  });

  it.each([
    ['a unit other than MJNx — an emission can never mint MJN', { unit: 'MJN', emit: [] }, /unit must be MJNx/],
    ['a missing emit[]', {}, /no emit\[\] schedule/],
    ['a non-array emit', { emit: 'nope' }, /no emit\[\] schedule/],
    ['a non-object rule', { emit: ['x'] }, /emit\[0\] must be an object/],
    ['an unknown recipient', { emit: [{ to: 'everyone', amount: 1, reason: 'r' }] }, /emit\[0\]\.to must be one of/],
    ['a missing reason', { emit: [{ to: 'subject', amount: 1 }] }, /reason is required/],
    ['an empty reason', { emit: [{ to: 'subject', amount: 1, reason: '' }] }, /reason is required/],
    ['neither amount nor percent', { emit: [{ to: 'subject', reason: 'r' }] }, /exactly one of amount \| percent/],
    ['both amount and percent', { emit: [{ to: 'subject', amount: 1, percent: 1, reason: 'r' }] }, /exactly one of amount \| percent/],
    ['a negative amount', { emit: [{ to: 'subject', amount: -1, reason: 'r' }] }, /amount must be a non-negative number/],
    ['a string amount', { emit: [{ to: 'subject', amount: '10', reason: 'r' }] }, /amount must be a non-negative number/],
    ['a non-finite percent', { emit: [{ to: 'subject', percent: Number.POSITIVE_INFINITY, reason: 'r' }] }, /percent must be a non-negative number/],
  ])('rejects %s', (_name, config, message) => {
    expect(() => parseEmissionRules(config as Record<string, unknown>)).toThrow(message);
  });
});

describe('resolveAmount / resolveTarget', () => {
  it('returns a fixed amount as-is', () => {
    expect(resolveAmount({ to: 'subject', amount: 7, reason: 'r' })).toBe(7);
  });

  it('applies a percent to the settlement value in cents, floored to 2 decimals', () => {
    expect(resolveAmount({ to: 'subject', percent: 0.25, reason: 'r' }, 1000)).toBe(2.5);
    expect(resolveAmount({ to: 'subject', percent: 0.5, reason: 'r' }, 333)).toBe(1.66);
  });

  it('resolves a percent to 0 with no settlement value', () => {
    expect(resolveAmount({ to: 'subject', percent: 0.25, reason: 'r' })).toBe(0);
  });

  it('maps each recipient to the right DID, null when absent', () => {
    const ctx = { issuerDid: 'did:i', subjectDid: 'did:s', scopeDid: 'did:c', nodeDid: 'did:n' };
    expect(resolveTarget({ to: 'subject', amount: 1, reason: 'r' }, ctx)).toBe('did:s');
    expect(resolveTarget({ to: 'issuer', amount: 1, reason: 'r' }, ctx)).toBe('did:i');
    expect(resolveTarget({ to: 'scope', amount: 1, reason: 'r' }, ctx)).toBe('did:c');
    expect(resolveTarget({ to: 'node', amount: 1, reason: 'r' }, ctx)).toBe('did:n');
    expect(resolveTarget({ to: 'scope', amount: 1, reason: 'r' }, { issuerDid: 'i', subjectDid: 's' })).toBeNull();
    expect(resolveTarget({ to: 'node', amount: 1, reason: 'r' }, { issuerDid: 'i', subjectDid: 's' })).toBeNull();
    expect(resolveTarget({ to: 'bogus' as never, amount: 1, reason: 'r' }, ctx)).toBeNull();
  });
});

describe('loadEmissionConfig', () => {
  const row = (reactors: unknown, extra: Record<string, unknown> = {}) => ({
    id: 'cfg_x',
    event_type: 'vouch',
    scope: null,
    version: '5', // postgres.js may hand integers back as strings for some drivers/settings
    enabled: true,
    reactors,
    ...extra,
  });

  it('returns the schedule with the row id, a numeric version and the raw settings', async () => {
    db.rows = [
      row([{ type: 'mjn', config: { attestationType: 'vouch', maxAttempts: 4, emit: [{ to: 'subject', amount: 2, reason: 'Vouched for' }] } }]),
    ];
    const cfg = await loadEmissionConfig('vouch', 'auth', 'vouch');

    expect(cfg).toMatchObject({
      configId: 'cfg_x',
      configVersion: 5,
      unit: 'MJNx',
      rules: [{ to: 'subject', amount: 2, reason: 'Vouched for' }],
      settings: { maxAttempts: 4 },
    });
  });

  it('treats an mjn entry without attestationType as covering the chain event type', async () => {
    db.rows = [row([{ type: 'mjn', config: { emit: [{ to: 'subject', amount: 2, reason: 'r' }] } }])];
    expect(await loadEmissionConfig('vouch', 'auth', 'vouch')).not.toBeNull();
  });

  it('returns null when the reactors column is not an array', async () => {
    db.rows = [row({ not: 'an array' })];
    expect(await loadEmissionConfig('vouch', 'auth', 'vouch')).toBeNull();
  });

  it('returns null when no row exists', async () => {
    db.rows = [];
    expect(await loadEmissionConfig('vouch', 'auth', 'vouch')).toBeNull();
  });

  it('throws on an invalid schedule so a bad operator edit is loud', async () => {
    db.rows = [row([{ type: 'mjn', config: { attestationType: 'vouch', emit: [{ to: 'subject', reason: 'r' }] } }])];
    await expect(loadEmissionConfig('vouch', 'auth', 'vouch')).rejects.toThrow(/exactly one of amount \| percent/);
  });
});

describe('code DEFAULTS carry no emission amounts (#2017 acceptance: zero amounts in code)', () => {
  const EMITTING = [
    'identity.created',
    'identity.verified.preliminary',
    'identity.verified.hard',
    'connection.accepted',
    'vouch',
    'tip.granted',
    'ticket.purchased',
    'listing.purchased',
    'group.created',
    'scope.onboard',
    'handle.claimed',
    'event.created',
    'event.attendance',
  ];

  it.each(EMITTING)('%s: the mjn entry is awaited and has no emit schedule or unit', async (type) => {
    db.rows = []; // no DB row → falls back to DEFAULTS
    const chain = await getChainConfig(type, `defaults-${type}`);
    const mjn = chain.reactors.find((r) => r.type === 'mjn');

    expect(chain.source).toBe('defaults');
    expect(mjn).toBeDefined();
    expect(mjn?.await).toBe(true);
    expect(mjn?.config).toEqual({ attestationType: type });
  });
});
