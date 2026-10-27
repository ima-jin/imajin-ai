import { randomBytes } from 'node:crypto';
import { vi } from 'vitest';
import { NextRequest } from 'next/server';
import { generateBootstrapKeypair } from '../src/ed25519';
import { sessionCookieName, type SessionConfig } from '../src/session';


export const signingKey = generateBootstrapKeypair();
export const code = randomBytes(32).toString('hex');
export const state = randomBytes(32).toString('hex');
export const callbackQuery = `?code=${code}&state=${state}`;
export const exchangeResult = {
  subjectDid: 'did:imajin:alice', attestationId: 'att_123',
  token: 'unit-test-app-token', expiresIn: 600, scopes: ['profile:read'],
};

export function withState(request: NextRequest, config: SessionConfig) {
  request.cookies.set(`${sessionCookieName(config)}_state`, state);
  return request;
}

export function mockCallbackFetch(profile: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    Response.json(url.endsWith('/auth/api/apps/token') ? exchangeResult : profile)));
}
