import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDeviceTicketHelpers } from '../connector-device-ticket';

// ─── connector-device-ticket.ts (#1391) ──────────────────────────────────────
//
// The ticket is the only thing standing between a browser poll loop and a
// device code, so the properties that matter are: it round-trips, it cannot be
// tampered with, it expires, and two connectors cannot redeem each other's.

const OWNER = 'did:imajin:eric';
const DEVICE_CODE = 'dev-code-xyz';

const { signDeviceTicket, verifyDeviceTicket } = createDeviceTicketHelpers('github_device');

beforeEach(() => {
  vi.stubEnv('AUTH_PRIVATE_KEY', 'test-hmac-secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('device tickets', () => {
  it('round-trips the DID and device code', () => {
    const verified = verifyDeviceTicket(signDeviceTicket(OWNER, DEVICE_CODE));

    expect(verified).toEqual({ did: OWNER, deviceCode: DEVICE_CODE });
  });

  it('mints a distinct ticket each time for the same inputs', () => {
    expect(signDeviceTicket(OWNER, DEVICE_CODE)).not.toBe(signDeviceTicket(OWNER, DEVICE_CODE));
  });

  it('rejects a ticket whose DID was swapped under a reused signature', () => {
    const [payloadB64, sig] = signDeviceTicket(OWNER, DEVICE_CODE).split('.');
    const original = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
    const forged = Buffer.from(
      JSON.stringify({ ...original, did: 'did:imajin:mallory' }),
    ).toString('base64url');

    expect(() => verifyDeviceTicket(`${forged}.${sig}`)).toThrow(/signature mismatch/);
  });

  it('rejects a malformed ticket', () => {
    expect(() => verifyDeviceTicket('nope')).toThrow(/malformed/);
  });

  it('rejects a ticket past its TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00Z'));
    const ticket = signDeviceTicket(OWNER, DEVICE_CODE);

    vi.setSystemTime(new Date('2026-08-01T00:20:00Z')); // +20 min > 16 min TTL
    expect(() => verifyDeviceTicket(ticket)).toThrow(/expired/);
  });

  it('is still valid inside the TTL', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-01T00:00:00Z'));
    const ticket = signDeviceTicket(OWNER, DEVICE_CODE);

    vi.setSystemTime(new Date('2026-08-01T00:10:00Z'));
    expect(verifyDeviceTicket(ticket).deviceCode).toBe(DEVICE_CODE);
  });

  it('refuses to sign without a server secret', () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', '');

    expect(() => signDeviceTicket(OWNER, DEVICE_CODE)).toThrow(/AUTH_PRIVATE_KEY is not set/);
  });
});
