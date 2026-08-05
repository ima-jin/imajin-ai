import { describe, it, expect, beforeEach, vi } from 'vitest';
import { brokerPredicateInvalidationReactor } from '../src/reactors/broker-predicate-invalidation';

const { calls, fakeSql } = vi.hoisted(() => {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const fakeSql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ text: strings.join(' ? '), values });
    return Promise.resolve([]);
  };
  return { calls, fakeSql };
});

vi.mock('@imajin/db', () => ({ getClient: () => fakeSql }));

describe('brokerPredicateInvalidationReactor', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('revokes broker predicate attestations for changed profile fields', async () => {
    await brokerPredicateInvalidationReactor({
      type: 'profile.field.changed',
      issuer: 'did:imajin:traveler',
      subject: 'did:imajin:traveler',
      scope: 'profile',
      payload: {
        subjectDid: 'did:imajin:traveler',
        fields: ['allergies', 'dietary'],
        context_id: 'did:imajin:traveler',
        context_type: 'profile',
      },
    }, {});

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('UPDATE auth.attestations');
    expect(calls[0].text).toContain('context_type = \'broker.predicate\'');
    expect(calls[0].values).toEqual(['did:imajin:traveler', ['allergies', 'dietary']]);
  });

  it('does nothing when no changed fields are present', async () => {
    await brokerPredicateInvalidationReactor({
      type: 'profile.field.changed',
      issuer: 'did:imajin:traveler',
      subject: 'did:imajin:traveler',
      scope: 'profile',
      payload: {
        subjectDid: 'did:imajin:traveler',
        fields: [],
        context_id: 'did:imajin:traveler',
        context_type: 'profile',
      },
    }, {});

    expect(calls).toEqual([]);
  });
});
