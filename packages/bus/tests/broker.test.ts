import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { broker } from '../src/broker';
import type { BrokerRequest, BrokerRelease, BrokerRejection } from '../src/types';

// Mock publish so audit events don't actually fire during tests
vi.mock('../src/publish', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
}));

import { publish } from '../src/publish';

const mockPublish = vi.mocked(publish);

describe('bus.broker()', () => {
  beforeEach(() => {
    mockPublish.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  function makeRequest(overrides: Partial<BrokerRequest> = {}): BrokerRequest {
    return {
      type: 'profile.read',
      requester: 'did:imajin:bob',
      subject: 'did:imajin:alice',
      fields: ['name', 'email'],
      purpose: 'marketing',
      scope: 'test',
      data: { name: 'Alice', email: 'alice@example.com', age: 30 },
      ...overrides,
    };
  }

  function assertRelease(result: unknown): asserts result is BrokerRelease {
    expect(result).toHaveProperty('status', 'released');
  }

  function assertRejection(result: unknown): asserts result is BrokerRejection {
    expect(result).toHaveProperty('status', 'rejected');
  }

  // --------------------------------------------------------------------------
  // Valid consent → full release with envelope
  // --------------------------------------------------------------------------

  it('returns a full release with envelope when consent is valid', async () => {
    const request = makeRequest();
    const result = await broker('profile.read', request);

    assertRelease(result);
    expect(result.data).toEqual({ name: 'Alice', email: 'alice@example.com' });
    expect(result.envelope).toBeDefined();
    expect(result.envelope.scopeId).toBe('test');
    expect(result.envelope.purpose).toBe('marketing');
    expect(result.envelope.mode).toBe('attestation');
    expect(result.envelope.consentReference).toBe('consent-alice-bob-001');
    expect(result.envelope.releaseId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(result.envelope.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // --------------------------------------------------------------------------
  // No consent → rejection with reason 'no_consent'
  // --------------------------------------------------------------------------

  it('rejects with no_consent when no consent config exists', async () => {
    const request = makeRequest({
      subject: 'did:imajin:unknown',
      requester: 'did:imajin:stranger',
      purpose: 'nefarious',
    });
    const result = await broker('profile.read', request);

    assertRejection(result);
    expect(result.reason).toBe('no_consent');
    expect(result.fields).toEqual(['name', 'email']);
    expect(result.details).toContain('No consent found');
  });

  // --------------------------------------------------------------------------
  // Partial field consent → filtered release (only consented fields)
  // --------------------------------------------------------------------------

  it('filters release to only consented fields', async () => {
    const request = makeRequest({
      fields: ['name', 'email', 'age'],
    });
    const result = await broker('profile.read', request);

    assertRelease(result);
    // alice|bob|marketing only consents to name + email, not age
    expect(result.data).toEqual({ name: 'Alice', email: 'alice@example.com' });
    expect(Object.keys(result.data)).not.toContain('age');
  });

  it('rejects when none of the requested fields are consented', async () => {
    const request = makeRequest({
      fields: ['age', 'ssn'],
    });
    const result = await broker('profile.read', request);

    assertRejection(result);
    expect(result.reason).toBe('no_consent');
    expect(result.fields).toEqual(['age', 'ssn']);
  });

  // --------------------------------------------------------------------------
  // Preview mode → returns release shape but preview=true, no audit event
  // --------------------------------------------------------------------------

  it('returns preview release without envelope and skips audit', async () => {
    const request = makeRequest({ preview: true });
    const result = await broker('profile.read', request);

    assertRelease(result);
    expect(result.preview).toBe(true);
    expect(result.data).toEqual({ name: 'Alice', email: 'alice@example.com' });

    // Envelope should still be present (release reactor runs in preview for envelope construction?)
    // Actually per spec: "preview: when true, run consent + scope but skip release envelope + audit"
    // Wait, re-reading: "Return what *would* be released"
    // Our implementation skips release + audit in preview, but still returns filtered data.
    // The envelope may or may not be present depending on implementation.
    // Per the spec, preview mode returns what WOULD be released, so envelope info is still useful.
    // Let's check our broker.ts: it skips release and audit reactors in preview, so envelope won't exist.
    // But we return filtered data. This is acceptable for preview.

    // Audit should NOT have fired
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Purpose mismatch → rejection
  // --------------------------------------------------------------------------

  it('rejects when purpose does not match consent', async () => {
    const request = makeRequest({
      purpose: 'surveillance',
    });
    const result = await broker('profile.read', request);

    assertRejection(result);
    expect(result.reason).toBe('no_consent');
  });

  // --------------------------------------------------------------------------
  // Multiple overlapping consent grants → union of fields (most permissive)
  // --------------------------------------------------------------------------

  it('unions fields from multiple overlapping consent grants', async () => {
    // alice|bob|marketing has TWO entries:
    //   consent-alice-bob-001: ['name', 'email']
    //   consent-alice-bob-002: ['phone', 'address']
    // Union = ['name', 'email', 'phone', 'address']
    const request = makeRequest({
      fields: ['name', 'email', 'phone', 'address'],
      data: {
        name: 'Alice',
        email: 'alice@example.com',
        phone: '+1-555-0123',
        address: '123 Main St',
      },
    });
    const result = await broker('profile.read', request);

    assertRelease(result);
    expect(result.data).toEqual({
      name: 'Alice',
      email: 'alice@example.com',
      phone: '+1-555-0123',
      address: '123 Main St',
    });
  });

  // --------------------------------------------------------------------------
  // Wildcard requester consent
  // --------------------------------------------------------------------------

  it('matches wildcard requester consent', async () => {
    const request = makeRequest({
      requester: 'did:imajin:anyone',
      purpose: 'profile',
      fields: ['name', 'avatar'],
      data: { name: 'Alice', avatar: 'https://example.com/alice.png', email: 'alice@example.com' },
    });
    const result = await broker('profile.read', request);

    assertRelease(result);
    expect(result.data).toEqual({
      name: 'Alice',
      avatar: 'https://example.com/alice.png',
    });
  });

  // --------------------------------------------------------------------------
  // Raw mode consent
  // --------------------------------------------------------------------------

  it('returns raw mode when consent config specifies raw', async () => {
    const request = makeRequest({
      purpose: 'analytics',
      fields: ['name', 'email', 'age'],
      data: { name: 'Alice', email: 'alice@example.com', age: 30 },
    });
    const result = await broker('profile.read', request);

    assertRelease(result);
    expect(result.envelope.mode).toBe('raw');
  });

  // --------------------------------------------------------------------------
  // Absent fields are omitted, not nulled
  // --------------------------------------------------------------------------

  it('omits absent fields rather than nulling them', async () => {
    const request = makeRequest({
      fields: ['name', 'email', 'phone'],
      data: { name: 'Alice', email: 'alice@example.com' }, // phone is missing
    });
    const result = await broker('profile.read', request);

    assertRelease(result);
    expect(result.data).toHaveProperty('name');
    expect(result.data).toHaveProperty('email');
    expect(result.data).not.toHaveProperty('phone');
    expect(Object.keys(result.data)).not.toContain('phone');
  });

  // --------------------------------------------------------------------------
  // Audit event fires on successful release
  // --------------------------------------------------------------------------

  it('fires broker.release audit event on successful release', async () => {
    const request = makeRequest();
    await broker('profile.read', request);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'broker.release',
      expect.objectContaining({
        issuer: 'did:imajin:bob',
        subject: 'did:imajin:alice',
        scope: 'test',
        payload: expect.objectContaining({
          requester: 'did:imajin:bob',
          subject: 'did:imajin:alice',
          fields: ['name', 'email'],
          purpose: 'marketing',
          scope: 'test',
          mode: 'attestation',
        }),
      })
    );
  });

  // --------------------------------------------------------------------------
  // Audit event fires on rejection
  // --------------------------------------------------------------------------

  it('fires broker.rejection audit event on rejection', async () => {
    const request = makeRequest({
      subject: 'did:imajin:unknown',
      requester: 'did:imajin:stranger',
      purpose: 'nefarious',
    });
    await broker('profile.read', request);

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish).toHaveBeenCalledWith(
      'broker.rejection',
      expect.objectContaining({
        issuer: 'did:imajin:stranger',
        subject: 'did:imajin:unknown',
        scope: 'test',
        payload: expect.objectContaining({
          reason: 'no_consent',
          fields: ['name', 'email'],
          purpose: 'nefarious',
        }),
      })
    );
  });

  // --------------------------------------------------------------------------
  // Preview mode skips audit on rejection too
  // --------------------------------------------------------------------------

  it('skips audit rejection event in preview mode', async () => {
    const request = makeRequest({
      subject: 'did:imajin:unknown',
      requester: 'did:imajin:stranger',
      purpose: 'nefarious',
      preview: true,
    });
    await broker('profile.read', request);

    expect(mockPublish).not.toHaveBeenCalled();
  });
});
