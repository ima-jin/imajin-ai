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
import * as jose from 'jose';
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

describe('session-app token with several audiences (#2663)', () => {
  const MEDIA_HOST = 'jin.imajin.ai';

  it('verifies for each audience it carries and reports the audience asked for', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: [APP_HOST, MEDIA_HOST], scopes: ['profile:read'] });

    const forApp = await verifySessionAppTokenLocal(token, APP_HOST);
    const forMedia = await verifySessionAppTokenLocal(token, MEDIA_HOST);

    expect(forApp).toMatchObject({ aud: APP_HOST, auds: [APP_HOST, MEDIA_HOST] });
    expect(forMedia).toMatchObject({ aud: MEDIA_HOST, auds: [APP_HOST, MEDIA_HOST], scopes: ['profile:read'] });
  });

  it('reports the first audience as primary when none is asked for', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: [APP_HOST, MEDIA_HOST], scopes: [] });

    const claims = await verifySessionAppTokenLocal(token);

    expect(claims).toMatchObject({ aud: APP_HOST, auds: [APP_HOST, MEDIA_HOST] });
  });

  it('rejects an audience the token does not carry', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: [APP_HOST, MEDIA_HOST], scopes: [] });

    await expect(verifySessionAppTokenLocal(token, OTHER_HOST)).resolves.toBeNull();
  });

  it('writes a single audience as a plain string claim, unchanged from before #2663', async () => {
    const asString = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: [] });
    const asOneElementList = await createSessionAppToken({ sub: USER_DID, aud: [APP_HOST], scopes: [] });

    expect(jose.decodeJwt(asString).aud).toBe(APP_HOST);
    expect(jose.decodeJwt(asOneElementList).aud).toBe(APP_HOST);
    await expect(verifySessionAppTokenLocal(asOneElementList, APP_HOST)).resolves.toMatchObject({ auds: [APP_HOST] });
  });

  it('writes several audiences as a list claim', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: [APP_HOST, MEDIA_HOST], scopes: [] });

    expect(jose.decodeJwt(token).aud).toEqual([APP_HOST, MEDIA_HOST]);
  });
});

describe('session-app token act-as claim (#2639 / #2644)', () => {
  const GROUP_DID = 'did:imajin:group-xyz';

  it('round-trips the actingAs claim', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: [], actingAs: GROUP_DID });

    const claims = await verifySessionAppTokenLocal(token, APP_HOST);

    expect(claims?.actingAs).toBe(GROUP_DID);
    expect(claims?.sub).toBe(USER_DID);
  });

  it('writes no acting_as claim when none is given, so ordinary tokens are unchanged', async () => {
    const token = await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: [] });

    expect(jose.decodeJwt(token)).not.toHaveProperty('acting_as');
    expect(await verifySessionAppTokenLocal(token, APP_HOST)).not.toHaveProperty('actingAs');
  });

  it('keeps the same lifetime as an ordinary token (act-as does not lengthen expiry)', async () => {
    const plain = jose.decodeJwt(await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: [] }));
    const actAs = jose.decodeJwt(await createSessionAppToken({ sub: USER_DID, aud: APP_HOST, scopes: [], actingAs: GROUP_DID }));

    expect(actAs.exp! - actAs.iat!).toBe(plain.exp! - plain.iat!);
  });
});
