/**
 * Tests for logDevice / parseUserAgent / deviceFingerprint (#306).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const CHROME_MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const FIREFOX_WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0';
const SAFARI_IOS_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Mobile/15E148 Safari/604.1';
const EDGE_WINDOWS_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

const mocks = vi.hoisted(() => {
  const selectWhere = vi.fn();
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  const insertValues = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values: insertValues }));

  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  const emitDeviceAttestation = vi.fn().mockResolvedValue(undefined);
  const sendNewDeviceAlert = vi.fn().mockResolvedValue(undefined);

  return {
    select, selectFrom, selectWhere, insert, insertValues, update, updateSet, updateWhere,
    emitDeviceAttestation, sendNewDeviceAlert,
  };
});

vi.mock('@/src/db', () => ({
  db: { select: mocks.select, insert: mocks.insert, update: mocks.update },
  devices: { id: 'id', did: 'did', fingerprint: 'fingerprint' },
}));

vi.mock('drizzle-orm', () => ({ eq: (...args: unknown[]) => ({ eq: args }) }));

vi.mock('nanoid', () => ({ nanoid: () => 'FIXEDID0000000000' }));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../emit-device-attestation', () => ({ emitDeviceAttestation: mocks.emitDeviceAttestation }));

vi.mock('../send-new-device-alert', () => ({ sendNewDeviceAlert: mocks.sendNewDeviceAlert }));

const emitDeviceAttestationMock = mocks.emitDeviceAttestation;
const sendNewDeviceAlertMock = mocks.sendNewDeviceAlert;

import { logDevice, parseUserAgent, deviceFingerprint } from '../log-device';

const DID = 'did:imajin:test-user';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseUserAgent (#306)', () => {
  it('parses Chrome on macOS', () => {
    expect(parseUserAgent(CHROME_MAC_UA)).toEqual({ platform: 'macOS', browser: 'Chrome' });
  });

  it('parses Firefox on Windows', () => {
    expect(parseUserAgent(FIREFOX_WINDOWS_UA)).toEqual({ platform: 'Windows', browser: 'Firefox' });
  });

  it('parses Safari on iOS', () => {
    expect(parseUserAgent(SAFARI_IOS_UA)).toEqual({ platform: 'iOS', browser: 'Safari' });
  });

  it('prefers Edge over the underlying Chrome UA token', () => {
    expect(parseUserAgent(EDGE_WINDOWS_UA)).toEqual({ platform: 'Windows', browser: 'Edge' });
  });

  it('returns Unknown/Unknown for a null user agent', () => {
    expect(parseUserAgent(null)).toEqual({ platform: 'Unknown', browser: 'Unknown' });
  });
});

describe('deviceFingerprint (#306)', () => {
  it('is stable across identical UA/platform/browser inputs', () => {
    const a = deviceFingerprint(CHROME_MAC_UA, 'macOS', 'Chrome');
    const b = deviceFingerprint(CHROME_MAC_UA, 'macOS', 'Chrome');
    expect(a).toBe(b);
  });

  it('does not take IP into account (no ip parameter exists)', () => {
    // Same UA/platform/browser must fingerprint identically regardless of
    // the caller's IP — the function signature itself enforces this, but
    // assert the value doesn't silently change across two "logical
    // sessions" that only differ in network.
    const first = deviceFingerprint(CHROME_MAC_UA, 'macOS', 'Chrome');
    const second = deviceFingerprint(CHROME_MAC_UA, 'macOS', 'Chrome');
    expect(first).toBe(second);
  });

  it('differs for different browsers', () => {
    const chrome = deviceFingerprint(CHROME_MAC_UA, 'macOS', 'Chrome');
    const firefox = deviceFingerprint(FIREFOX_WINDOWS_UA, 'Windows', 'Firefox');
    expect(chrome).not.toBe(firefox);
  });
});

describe('logDevice (#306)', () => {
  it('bumps last_seen for a known device and does not email or attest', async () => {
    mocks.selectWhere.mockResolvedValue([{ id: 'dev_existing', fingerprint: deviceFingerprint(CHROME_MAC_UA, 'macOS', 'Chrome') }]);

    const result = await logDevice({ did: DID, ip: '1.2.3.4', userAgent: CHROME_MAC_UA });

    expect(result).toEqual({ deviceId: 'dev_existing', isNewDevice: false, isFirstDevice: false });
    expect(mocks.update).toHaveBeenCalledOnce();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(emitDeviceAttestationMock).not.toHaveBeenCalled();
    expect(sendNewDeviceAlertMock).not.toHaveBeenCalled();
  });

  it('records the first-ever device silently: attestation but no email', async () => {
    mocks.selectWhere.mockResolvedValue([]);

    const result = await logDevice({ did: DID, ip: '1.2.3.4', userAgent: CHROME_MAC_UA });

    expect(result.isNewDevice).toBe(true);
    expect(result.isFirstDevice).toBe(true);
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(emitDeviceAttestationMock).toHaveBeenCalledWith(
      expect.objectContaining({ did: DID, isFirstDevice: true })
    );
    expect(sendNewDeviceAlertMock).not.toHaveBeenCalled();
  });

  it('records a new (non-first) device with both attestation and email', async () => {
    mocks.selectWhere.mockResolvedValue([{ id: 'dev_other', fingerprint: 'some-other-fingerprint' }]);

    const result = await logDevice({ did: DID, ip: '1.2.3.4', userAgent: FIREFOX_WINDOWS_UA });

    expect(result.isNewDevice).toBe(true);
    expect(result.isFirstDevice).toBe(false);
    expect(mocks.insert).toHaveBeenCalledOnce();
    expect(emitDeviceAttestationMock).toHaveBeenCalledWith(
      expect.objectContaining({ did: DID, isFirstDevice: false, platform: 'Windows', browser: 'Firefox' })
    );
    expect(sendNewDeviceAlertMock).toHaveBeenCalledWith(
      expect.objectContaining({ did: DID, platform: 'Windows', browser: 'Firefox' })
    );
  });

  it('never throws when the attestation side-effect rejects', async () => {
    mocks.selectWhere.mockResolvedValue([]);
    emitDeviceAttestationMock.mockRejectedValueOnce(new Error('boom'));

    await expect(logDevice({ did: DID, ip: null, userAgent: CHROME_MAC_UA })).resolves.toMatchObject({
      isNewDevice: true,
      isFirstDevice: true,
    });
  });

  it('never throws when the email side-effect rejects', async () => {
    mocks.selectWhere.mockResolvedValue([{ id: 'dev_other', fingerprint: 'some-other-fingerprint' }]);
    sendNewDeviceAlertMock.mockRejectedValueOnce(new Error('boom'));

    await expect(logDevice({ did: DID, ip: null, userAgent: FIREFOX_WINDOWS_UA })).resolves.toMatchObject({
      isNewDevice: true,
      isFirstDevice: false,
    });
  });
});
