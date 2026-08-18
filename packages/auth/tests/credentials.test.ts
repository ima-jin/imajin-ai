/**
 * `resolveDidForEmail` / `resolveEmailForDid` (#1858, extending #1834's
 * structural-review consolidation proposal) — the single shared seam every
 * caller (invite-create's mint decision, invite-accept's identity check,
 * ...) should use instead of hand-rolling its own credentials-only or
 * contactEmail-only query. Precedence under test:
 *   1. auth.credentials (type='email')
 *   2. profile.profiles.contact_email
 *   3. auth.identities.contact_email
 *
 * Mocking pattern follows packages/bus/AGENTS.md's convention for testing
 * raw-SQL `getClient()` consumers: a fake tagged-template function that
 * records query text/values and resolves from a per-test result queue.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { fakeSql, sqlCalls, queueResult, resetQueue } = vi.hoisted(() => {
  const sqlCalls: Array<{ text: string; values: unknown[] }> = [];
  const queue: unknown[][] = [];
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ text: strings.join(' ? '), values });
    return Promise.resolve(queue.shift() ?? []);
  };
  return {
    fakeSql,
    sqlCalls,
    queueResult: (rows: unknown[]) => queue.push(rows),
    resetQueue: () => queue.splice(0, queue.length),
  };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

import { getDidForEmail, getEmailForDid, resolveDidForEmail, resolveEmailForDid } from '../src/credentials';

const DID = 'did:imajin:kia';

beforeEach(() => {
  vi.clearAllMocks();
  sqlCalls.length = 0;
  resetQueue();
});

describe('resolveDidForEmail — precedence order (#1858)', () => {
  it('resolves via auth.credentials and never queries profile/identities when it hits', async () => {
    queueResult([{ did: DID }]);

    const result = await resolveDidForEmail('kia@example.com');

    expect(result).toBe(DID);
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].text).toContain('auth.credentials');
  });

  it('falls back to profile.profiles.contact_email when no credential row matches', async () => {
    queueResult([]); // auth.credentials miss
    queueResult([{ did: DID }]); // profile.profiles hit

    const result = await resolveDidForEmail('kia@example.com');

    expect(result).toBe(DID);
    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[1].text).toContain('profile.profiles');
  });

  it('falls back to auth.identities.contact_email when neither credential nor profile match', async () => {
    queueResult([]); // auth.credentials miss
    queueResult([]); // profile.profiles miss
    queueResult([{ did: DID }]); // auth.identities hit

    const result = await resolveDidForEmail('kia@example.com');

    expect(result).toBe(DID);
    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[2].text).toContain('auth.identities');
  });

  it('returns null when the email is not known to any of the three sources', async () => {
    queueResult([]);
    queueResult([]);
    queueResult([]);

    const result = await resolveDidForEmail('nobody@example.com');

    expect(result).toBeNull();
    expect(sqlCalls).toHaveLength(3);
  });

  it('normalizes (lowercase + trim) the email before every query', async () => {
    queueResult([{ did: DID }]);

    await resolveDidForEmail('  Kia@Example.COM  ');

    expect(sqlCalls[0].values).toContain('kia@example.com');
  });
});

describe('resolveEmailForDid — precedence order (#1858)', () => {
  it('resolves via auth.credentials and never queries profile/identities when it hits', async () => {
    queueResult([{ value: 'kia@example.com' }]);

    const result = await resolveEmailForDid(DID);

    expect(result).toBe('kia@example.com');
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].text).toContain('auth.credentials');
  });

  it('falls back to profile.profiles.contact_email when no credential exists', async () => {
    queueResult([]); // auth.credentials miss
    queueResult([{ contact_email: 'kia@profile.example.com' }]); // profile hit

    const result = await resolveEmailForDid(DID);

    expect(result).toBe('kia@profile.example.com');
    expect(sqlCalls).toHaveLength(2);
    expect(sqlCalls[1].text).toContain('profile.profiles');
  });

  it('falls back to auth.identities.contact_email when neither credential nor profile has an email', async () => {
    queueResult([]);
    queueResult([]);
    queueResult([{ contact_email: 'kia@identity.example.com' }]);

    const result = await resolveEmailForDid(DID);

    expect(result).toBe('kia@identity.example.com');
    expect(sqlCalls).toHaveLength(3);
    expect(sqlCalls[2].text).toContain('auth.identities');
  });

  it('returns null when the DID has no email on file anywhere', async () => {
    queueResult([]);
    queueResult([]);
    queueResult([]);

    const result = await resolveEmailForDid(DID);

    expect(result).toBeNull();
  });
});

describe('getDidForEmail / getEmailForDid — existing credentials-only lookups unchanged', () => {
  it('getDidForEmail normalizes the email and queries only auth.credentials', async () => {
    queueResult([{ did: DID }]);

    const result = await getDidForEmail('  Kia@Example.COM  ');

    expect(result).toBe(DID);
    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0].text).toContain('auth.credentials');
    expect(sqlCalls[0].values).toContain('kia@example.com');
  });

  it('getEmailForDid returns null when the DID has no email credential', async () => {
    queueResult([]);

    const result = await getEmailForDid(DID);

    expect(result).toBeNull();
  });
});
