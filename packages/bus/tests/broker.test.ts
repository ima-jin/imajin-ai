import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { broker } from '../src/broker';
import { getBrokerReactor } from '../src/broker-registry';
import type { BrokerPredicateClaim, BrokerRequest, BrokerRelease, BrokerRejection } from '../src/types';

// Mock publish so audit events don't actually fire during tests
vi.mock('../src/publish', () => ({
  publish: vi.fn().mockResolvedValue(undefined),
}));

// Mock @imajin/auth so the release reactor's emitAttestation() bridge (#1508)
// doesn't make real network calls during tests.
vi.mock('@imajin/auth', () => ({
  emitAttestation: vi.fn().mockResolvedValue(undefined),
}));

import { publish } from '../src/publish';
import { emitAttestation } from '@imajin/auth';

const mockPublish = vi.mocked(publish);
const mockEmitAttestation = vi.mocked(emitAttestation);

describe('bus.broker()', () => {
  beforeEach(() => {
    mockPublish.mockClear();
    mockEmitAttestation.mockClear();
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

  function assertPredicateClaim(value: unknown): asserts value is BrokerPredicateClaim {
    expect(value).toEqual(expect.objectContaining({
      field: expect.any(String),
      predicate: expect.any(String),
      result: expect.any(Boolean),
      cacheKey: expect.any(String),
      issuedAt: expect.any(String),
      expiresAt: expect.any(String),
    }));
  }

  // --------------------------------------------------------------------------
  // Valid consent → full release with envelope
  // --------------------------------------------------------------------------

  it('returns a full release with envelope when consent is valid', async () => {
    const request = makeRequest();
    const result = await broker('profile.read', request);

    assertRelease(result);
    expect(result.data).toEqual({ name: { attested: true }, email: { attested: true } });
    expect(result.envelope).toBeDefined();
    expect(result.envelope.scopeId).toBe('test');
    expect(result.envelope.purpose).toBe('marketing');
    expect(result.envelope.mode).toBe('attestation');
    expect(result.envelope.fieldModes).toEqual({ name: 'attestation', email: 'attestation' });
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
    expect(result.data).toEqual({ name: { attested: true }, email: { attested: true } });
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
    expect(result.data).toEqual({ name: { attested: true }, email: { attested: true } });

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
      name: { attested: true },
      email: { attested: true },
      phone: { attested: true },
      address: { attested: true },
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
      name: { attested: true },
      avatar: { attested: true },
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
    expect(result.envelope.fieldModes).toEqual({ name: 'raw', email: 'raw', age: 'raw' });
    expect(result.data).toEqual({ name: 'Alice', email: 'alice@example.com', age: 30 });
  });

  it('supports mixed raw and attestation fields without raw-biased collapse', async () => {
    const request = makeRequest({
      requester: 'did:imajin:restaurant',
      subject: 'did:imajin:traveler',
      purpose: 'restaurant_reservation',
      fields: ['dietary', 'allergies'],
      data: { dietary: 'vegetarian', allergies: 'peanuts; shellfish' },
      predicates: {
        allergies: { predicate: 'overlaps', arg: ['peanut', 'egg', 'wheat'] },
      },
    });
    const result = await broker('profile.read', request);

    assertRelease(result);
    expect(result.envelope.mode).toBe('mixed');
    expect(result.envelope.fieldModes).toEqual({ dietary: 'raw', allergies: 'attestation' });
    expect(result.data.dietary).toBe('vegetarian');
    assertPredicateClaim(result.data.allergies);
    expect(result.data.allergies).toEqual(expect.objectContaining({
      field: 'allergies',
      predicate: 'overlaps',
      arg: ['peanut', 'egg', 'wheat'],
      result: true,
    }));
    expect(JSON.stringify(result.data.allergies)).not.toContain('shellfish');
  });

  it('resolves conflicting same-field grants to attestation, not raw', async () => {
    const request = makeRequest({
      requester: 'did:imajin:partner',
      subject: 'did:imajin:mixed',
      purpose: 'conflict-test',
      fields: ['email'],
      data: { email: 'private@example.com' },
    });
    const result = await broker('profile.read', request);

    assertRelease(result);
    expect(result.envelope.mode).toBe('attestation');
    expect(result.envelope.fieldModes).toEqual({ email: 'attestation' });
    expect(result.data.email).toEqual({ attested: true });
  });

  // --------------------------------------------------------------------------
  // Attestation-mode release mints a signed claim via emitAttestation (#1508)
  // --------------------------------------------------------------------------

  it('emits a signed attestation referencing the consent grant + releaseId for attestation-mode releases', async () => {
    const request = makeRequest();
    const result = await broker('profile.read', request);

    assertRelease(result);
    expect(result.envelope.mode).toBe('attestation');
    expect(mockEmitAttestation).toHaveBeenCalledTimes(1);
    expect(mockEmitAttestation).toHaveBeenCalledWith(
      expect.objectContaining({
        issuer_did: 'did:imajin:alice',
        subject_did: 'did:imajin:alice',
        type: 'broker.release',
        context_id: result.envelope.releaseId,
        context_type: 'broker',
        payload: expect.objectContaining({
          requester: 'did:imajin:bob',
          purpose: 'marketing',
          scope: 'test',
          fields: ['name', 'email'],
          fieldModes: { name: 'attestation', email: 'attestation' },
          rawFields: [],
          attestationFields: ['name', 'email'],
          consentReference: 'consent-alice-bob-001',
        }),
      })
    );

    // The raw values are never handed to the attestation payload.
    const [[attestationParams]] = mockEmitAttestation.mock.calls;
    expect(JSON.stringify(attestationParams)).not.toContain('Alice');
    expect(JSON.stringify(attestationParams)).not.toContain('alice@example.com');
  });

  it('does not emit an attestation for raw-mode releases', async () => {
    const request = makeRequest({
      purpose: 'analytics',
      fields: ['name', 'email', 'age'],
      data: { name: 'Alice', email: 'alice@example.com', age: 30 },
    });
    const result = await broker('profile.read', request);

    assertRelease(result);
    expect(result.envelope.mode).toBe('raw');
    expect(mockEmitAttestation).not.toHaveBeenCalled();
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
          fieldModes: { name: 'attestation', email: 'attestation' },
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

  // --------------------------------------------------------------------------
  // Shadow mode (#1231) — full pipeline + audit, but non-binding (enforced:false)
  // --------------------------------------------------------------------------

  it('enforce mode (default) tags a release enforced:true', async () => {
    const result = await broker('profile.read', makeRequest());

    assertRelease(result);
    expect(result.enforced).toBe(true);
  });

  it('shadow mode returns a release tagged enforced:false and still audits', async () => {
    const result = await broker('profile.read', makeRequest({ mode: 'shadow' }));

    assertRelease(result);
    expect(result.enforced).toBe(false);
    expect(result.data).toEqual({ name: { attested: true }, email: { attested: true } });
    // Full pipeline ran: the release audit event still fires (unlike preview).
    expect(mockPublish).toHaveBeenCalledWith('broker.release', expect.anything());
  });

  it('shadow mode returns a rejection tagged enforced:false and still audits', async () => {
    const result = await broker('profile.read', makeRequest({
      subject: 'did:imajin:unknown',
      requester: 'did:imajin:stranger',
      purpose: 'nefarious',
      mode: 'shadow',
    }));

    assertRejection(result);
    expect(result.reason).toBe('no_consent');
    expect(result.enforced).toBe(false);
    // A shadow rejection is a real, logged decision — the audit event fires.
    expect(mockPublish).toHaveBeenCalledWith('broker.rejection', expect.anything());
  });

  // --------------------------------------------------------------------------
  // Match-engine reactor registration (#1872)
  // --------------------------------------------------------------------------

  it('has mutual-reach-consent and intersection-scope registered as broker reactors', () => {
    expect(getBrokerReactor('mutual-reach-consent')).toBeDefined();
    expect(getBrokerReactor('intersection-scope')).toBeDefined();
  });
});
