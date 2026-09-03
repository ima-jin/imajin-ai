/**
 * Tests for the session-scoped app token primitive in jwt.ts (#1069 Phase 1).
 *
 * This token is minted from a caller's OWN first-party session (no app DID,
 * no attestation) to be handed to a specific app host. The properties that
 * matter: it round-trips sub/aud/scopes, it is bound to its audience (a
 * token minted for one app must not verify for another), it expires, and it
 * is distinguishable from the third-party `app+jwt` / `app-service+jwt`
 * tokens defined earlier in this file.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createSessionAppToken,
  verifySessionAppTokenLocal,
  createAppToken,
} from '../jwt';

const USER_DID = 'did:imajin:user-abc';
const APP_HOST = 'coffee.imajin.ai';
const OTHER_HOST = 'market.imajin.ai';

afterEach(() => {
  vi.useRealTimers();
});

describe('session-app token round-trip (#1069 Phase 1)', () => {
  it('mints and verifies a token, returning sub/aud/scopes', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: ['profile:read'] });

    const claims = await verifySessionAppTokenLocal(token, APP_HOST);

    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe(USER_DID);
    expect(claims!.aud).toBe(APP_HOST);
    expect(claims!.scopes).toEqual(['profile:read']);
  });

  it('mints a token with no scopes when none are requested', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: [] });
    const claims = await verifySessionAppTokenLocal(token, APP_HOST);

    expect(claims!.scopes).toEqual([]);
  });

  it('verifies without an expected audience when none is supplied', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: [] });
    const claims = await verifySessionAppTokenLocal(token);

    expect(claims!.aud).toBe(APP_HOST);
  });
});

describe('session-app token audience binding (#1069 Phase 1)', () => {
  it('rejects a token when the expected audience does not match', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: [] });

    const claims = await verifySessionAppTokenLocal(token, OTHER_HOST);

    expect(claims).toBeNull();
  });
});

describe('session-app token expiry (#1069 Phase 1)', () => {
  it('is valid immediately after mint', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));

    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: [] });

    vi.setSystemTime(new Date('2026-09-01T00:05:00Z')); // +5 min, inside the 10min TTL
    const claims = await verifySessionAppTokenLocal(token, APP_HOST);

    expect(claims).not.toBeNull();
  });

  it('rejects a token past its 10-minute TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));

    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: [] });

    vi.setSystemTime(new Date('2026-09-01T00:11:00Z')); // +11 min > 10min TTL
    const claims = await verifySessionAppTokenLocal(token, APP_HOST);

    expect(claims).toBeNull();
  });
});

describe('session-app tokens are distinct from third-party app tokens (#1069 Phase 1)', () => {
  it('rejects a garbage/tampered token', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: [] });
    const tampered = `${token.slice(0, -4)}abcd`;

    await expect(verifySessionAppTokenLocal(tampered, APP_HOST)).resolves.toBeNull();
  });

  it('does not accept a third-party app+jwt token as a session-app token', async () => {
    const appToken = await createAppToken({
      sub: USER_DID,
      azp: 'did:imajin:app:coffee',
      scope: 'profile:read',
      aud: APP_HOST,
      attestationId: 'att_1',
    });

    const claims = await verifySessionAppTokenLocal(appToken, APP_HOST);

    expect(claims).toBeNull();
  });
});
