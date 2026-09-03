import { createHash } from 'node:crypto';
import { db, devices } from '@/src/db';
import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { createLogger } from '@imajin/logger';
import { emitDeviceAttestation } from './emit-device-attestation';
import { sendNewDeviceAlert } from './send-new-device-alert';

const log = createLogger('kernel');

export interface UserAgentInfo {
  platform: string;
  browser: string;
}

// Order matters: `Array.find` returns the first match, so browsers whose UA
// also matches a broader/older pattern (e.g. Edge and Chrome both contain
// "Chrome/"; Chrome and Safari both contain "Safari/") must be listed first.
const BROWSER_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/edg\//i, 'Edge'],
  [/opr\/|opera/i, 'Opera'],
  [/chrome\//i, 'Chrome'],
  [/firefox\//i, 'Firefox'],
  [/safari\//i, 'Safari'],
];

// iOS UAs include "like Mac OS X" for compatibility, so the iOS check must
// come before the macOS one or every iPhone/iPad would be misread as a Mac.
const PLATFORM_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/windows/i, 'Windows'],
  [/iphone|ipad|ipod/i, 'iOS'],
  [/mac os|macintosh/i, 'macOS'],
  [/android/i, 'Android'],
  [/linux/i, 'Linux'],
];

function matchPattern(value: string, patterns: ReadonlyArray<readonly [RegExp, string]>): string {
  const found = patterns.find(([pattern]) => pattern.test(value));
  return found ? found[1] : 'Unknown';
}

/**
 * Parse a display-only platform + browser out of a User-Agent string (#306).
 * Best-effort: browsers increasingly freeze UA strings for privacy, so this
 * is a label, never a security boundary.
 */
export function parseUserAgent(userAgent: string | null): UserAgentInfo {
  if (!userAgent) return { platform: 'Unknown', browser: 'Unknown' };
  return {
    platform: matchPattern(userAgent, PLATFORM_PATTERNS),
    browser: matchPattern(userAgent, BROWSER_PATTERNS),
  };
}

/**
 * Derive a stable device fingerprint from platform + browser + User-Agent.
 * Deliberately excludes IP address (#306) — a device must not look "new"
 * every time the user's network changes. Non-cryptographic — a stable
 * identifier, not a security boundary.
 */
export function deviceFingerprint(userAgent: string | null, platform: string, browser: string): string {
  return createHash('sha256')
    .update(`${platform}:${browser}:${userAgent ?? ''}`)
    .digest('hex')
    .slice(0, 32);
}

export interface DeviceLoginParams {
  did: string;
  ip: string | null;
  userAgent: string | null;
}

export interface DeviceLoginResult {
  deviceId: string;
  /** True when this fingerprint had never been seen before for this DID. */
  isNewDevice: boolean;
  /** True when this is the DID's very first recorded device (silent — no email). */
  isFirstDevice: boolean;
}

/**
 * Record or refresh a device entry for the given DID on successful auth
 * (#306). Known device -> bump last_seen. New device (not the DID's first
 * ever) -> insert + email + attestation. First-ever device for a DID ->
 * insert silently (attestation only, no email — nothing to compare
 * against yet).
 *
 * Non-fatal to the login itself — callers wrap this in try/catch (or
 * `.catch()` on the returned promise) so a DB hiccup here never blocks
 * authentication.
 */
export async function logDevice(params: DeviceLoginParams): Promise<DeviceLoginResult> {
  const { did, ip, userAgent } = params;
  const { platform, browser } = parseUserAgent(userAgent);
  const fingerprint = deviceFingerprint(userAgent, platform, browser);
  const now = new Date();

  const existingForDid = await db
    .select({ id: devices.id, fingerprint: devices.fingerprint })
    .from(devices)
    .where(eq(devices.did, did));

  const matched = existingForDid.find((d) => d.fingerprint === fingerprint);

  if (matched) {
    await db
      .update(devices)
      .set({ lastSeenAt: now, ip, userAgent })
      .where(eq(devices.id, matched.id));
    return { deviceId: matched.id, isNewDevice: false, isFirstDevice: false };
  }

  const isFirstDevice = existingForDid.length === 0;
  const id = `dev_${nanoid(16)}`;

  await db.insert(devices).values({
    id,
    did,
    fingerprint,
    ip,
    userAgent,
    platform,
    browser,
    trusted: false,
    revoked: false,
    firstSeenAt: now,
    lastSeenAt: now,
  });

  await emitDeviceAttestation({ did, deviceId: id, platform, browser, isFirstDevice }).catch((err: unknown) =>
    log.error({ err: String(err) }, '[log-device] attestation failed (non-fatal)')
  );

  if (!isFirstDevice) {
    await sendNewDeviceAlert({ did, platform, browser }).catch((err: unknown) =>
      log.error({ err: String(err) }, '[log-device] new-device alert failed (non-fatal)')
    );
  }

  return { deviceId: id, isNewDevice: true, isFirstDevice };
}
