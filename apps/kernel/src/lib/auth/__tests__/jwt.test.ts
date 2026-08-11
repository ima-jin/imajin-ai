/**
 * Tests for the app-service credential shape minted/verified in jwt.ts (#1800).
 *
 * A service token (`typ: 'app-service+jwt'`) is the session-less credential a
 * registered app uses to call the kernel from an automated context (webhook,
 * cron, background settlement) with no human session. These tests pin the two
 * properties #1800 depends on:
 *
 *   - Attribution: sub === azp === the app's own DID, userDid never leaks a
 *     borrowed human identity (attestationId is always '').
 *   - Scope fidelity: whatever scopes are minted in are exactly what verify
 *     returns — no widening, no silent drop.
 *
 * Contrasted against the existing user-delegated app token (`app+jwt`) to
 * make the attribution difference explicit rather than assumed.
 */
import { describe, it, expect } from 'vitest';
import { createAppServiceToken, createAppToken, verifyAppToken } from '../jwt';

const APP_DID = 'did:imajin:agrifortress-webhook';
const HUMAN_DID = 'did:imajin:borrowed-human';

describe('app-service token attribution (#1800)', () => {
  it('mints a service token attributed to the app DID, never a human DID', async () => {
    const token = await createAppServiceToken({ azp: APP_DID, scope: 'supply:read' });
    const payload = await verifyAppToken(token);

    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe(APP_DID);
    expect(payload!.azp).toBe(APP_DID);
    expect(payload!.isServiceToken).toBe(true);
    // No delegating user and no borrowed consent attestation — the whole point.
    expect(payload!.attestationId).toBe('');
  });

  it('round-trips the exact granted scopes with no widening', async () => {
    const token = await createAppServiceToken({ azp: APP_DID, scope: 'supply:read supply:write' });
    const payload = await verifyAppToken(token);

    expect(payload!.scope.split(' ').filter(Boolean).sort()).toEqual(['supply:read', 'supply:write']);
  });

  it('mints a token with only the requested scope when scope is narrower', async () => {
    const token = await createAppServiceToken({ azp: APP_DID, scope: 'supply:read' });
    const payload = await verifyAppToken(token);

    expect(payload!.scope).toBe('supply:read');
  });

  it('is distinguishable from a user-delegated app token by isServiceToken + empty userDid', async () => {
    const serviceToken = await createAppServiceToken({ azp: APP_DID, scope: 'supply:read' });
    const delegatedToken = await createAppToken({
      sub: HUMAN_DID,
      azp: APP_DID,
      scope: 'supply:read',
      attestationId: 'att_human_consent',
    });

    const servicePayload = await verifyAppToken(serviceToken);
    const delegatedPayload = await verifyAppToken(delegatedToken);

    expect(servicePayload!.isServiceToken).toBe(true);
    expect(servicePayload!.sub).toBe(APP_DID); // never a human

    // At the payload level verifyAppToken always returns a boolean; it's the
    // HTTP-facing /token/verify route that omits the key entirely for
    // delegated tokens (see the verify route test for that JSON contract).
    expect(delegatedPayload!.isServiceToken).toBe(false);
    expect(delegatedPayload!.sub).toBe(HUMAN_DID);
    expect(delegatedPayload!.attestationId).toBe('att_human_consent');
  });

  it('rejects a garbage/tampered token', async () => {
    const token = await createAppServiceToken({ azp: APP_DID, scope: 'supply:read' });
    const tampered = `${token.slice(0, -4)}abcd`;

    await expect(verifyAppToken(tampered)).resolves.toBeNull();
  });
});
