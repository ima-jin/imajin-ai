import { describe, expect, it } from 'vitest';
import { MAX_REACH_MESSAGE_LENGTH, MAX_REPLY_HANDLE_LENGTH, parseReachDelivery } from '../reach-delivery-input';

const bundle = {
  message: 'Hello Ryan',
  topic: 'business_development',
  replyHandle: 'caller-transport:thread-1',
  purpose: 'agent.reach',
  field: 'contact_topics',
  predicate: 'contains',
  arg: 'business_development',
};

describe('reach delivery input', () => {
  it('leaves boolean-only asks unchanged', () => {
    expect(parseReachDelivery({})).toEqual({ ok: true });
  });

  it('accepts a complete bundle and preserves opaque bytes', () => {
    expect(parseReachDelivery(bundle)).toEqual({
      ok: true,
      delivery: { message: bundle.message, topic: bundle.topic, replyHandle: bundle.replyHandle },
    });
  });

  it.each([
    { message: undefined }, { topic: undefined }, { replyHandle: undefined },
    { message: '' }, { message: '   ' }, { message: 3 }, { topic: '' }, { topic: 'a'.repeat(201) },
    { message: 'a'.repeat(MAX_REACH_MESSAGE_LENGTH + 1) },
    { replyHandle: 'a'.repeat(MAX_REPLY_HANDLE_LENGTH + 1) },
    { replyHandle: ' ' }, { purpose: 'other' }, { field: 'other' },
    { predicate: 'is_empty' }, { arg: 'other' },
  ])('rejects incomplete, oversized or predicate-unbound input %j', (patch) => {
    expect(parseReachDelivery({ ...bundle, ...patch }).ok).toBe(false);
  });
});
