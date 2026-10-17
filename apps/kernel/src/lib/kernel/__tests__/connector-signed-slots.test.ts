import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOAuthStateHelpers } from '../connector-oauth-state';
import { createDeviceTicketHelpers } from '../connector-device-ticket';

beforeEach(() => { vi.stubEnv('AUTH_PRIVATE_KEY', 'test-slot-signing-key'); });
afterEach(() => { vi.unstubAllEnvs(); });

function swapSlot(token: string): string {
  const [body, signature] = token.split('.');
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
  payload.slot = 'primary';
  return `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}`;
}

describe('signed connection selectors', () => {
  it('binds the OAuth state slot alongside the app configuration owner', () => {
    const { signState, verifyState } = createOAuthStateHelpers('slot_state');
    const state = signState('did:imajin:owner', '/auth', 'did:imajin:app', 'work');
    expect(verifyState(state)).toMatchObject({ slot: 'work', appDid: 'did:imajin:app' });
    expect(() => verifyState(swapSlot(state))).toThrow(/signature mismatch/);
    expect(() => signState('did:imajin:owner', undefined, undefined, '../work')).toThrow('invalid_connection');
  });

  it('binds device tickets to the selected slot', () => {
    const { signDeviceTicket, verifyDeviceTicket } = createDeviceTicketHelpers('slot_device');
    const ticket = signDeviceTicket('did:imajin:owner', 'device-code', 'work');
    expect(verifyDeviceTicket(ticket)).toEqual({ did: 'did:imajin:owner', deviceCode: 'device-code', slot: 'work' });
    expect(() => verifyDeviceTicket(swapSlot(ticket))).toThrow(/signature mismatch/);
    expect(() => signDeviceTicket('did:imajin:owner', 'device-code', '../work')).toThrow('invalid_connection');
  });
});
