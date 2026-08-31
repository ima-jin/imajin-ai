/**
 * Tests for `unauthorizedResponse` / `hardDIDRequiredResponse` (#1899): every
 * 401/403 this helper produces carries an `onboarding` pointer to the agent
 * card, so a caller — human or a stranger's agent holding an unknown or
 * ungranted key — learns how to become a known one.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `middleware.ts` imports `@/src/db` for its chain-verification path, which
// eagerly connects via DATABASE_URL at import time. Neither function under
// test here touches the database, so a bare stub keeps this suite hermetic.
vi.mock('@/src/db', () => ({ db: {}, identityChains: {}, identities: {} }));

import { unauthorizedResponse, hardDIDRequiredResponse } from '../middleware';

// Same baseline convention as apps/kernel/src/lib/http/__tests__/node-url.test.ts:
// stub each key empty then delete it, so every test starts from a real "unset"
// state, and let vi.unstubAllEnvs() undo it — no manual save/restore array.
const ENV_KEYS = ['APP_URL', 'NEXT_PUBLIC_BASE_URL', 'NEXT_PUBLIC_SERVICE_PREFIX', 'NEXT_PUBLIC_DOMAIN'] as const;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    vi.stubEnv(key, '');
    delete process.env[key];
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('unauthorizedResponse', () => {
  it('returns 401 with the default message', async () => {
    const res = unauthorizedResponse();
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Authentication required');
  });

  it('preserves a custom message', async () => {
    const res = unauthorizedResponse('Session expired');
    const body = await res.json();
    expect(body.error).toBe('Session expired');
  });

  it('includes an onboarding pointer to this node\'s agent card', async () => {
    vi.stubEnv('APP_URL', 'https://jin.imajin.ai');
    const res = unauthorizedResponse();
    const body = await res.json();
    expect(body.onboarding).toBe('https://jin.imajin.ai/.well-known/agent.json');
  });
});

describe('hardDIDRequiredResponse', () => {
  it('returns 403 with upgradeRequired and the default message', async () => {
    const res = hardDIDRequiredResponse();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('This action requires a full identity (hard DID)');
    expect(body.upgradeRequired).toBe(true);
  });

  it('includes an onboarding pointer to this node\'s agent card', async () => {
    vi.stubEnv('APP_URL', 'https://jin.imajin.ai');
    const res = hardDIDRequiredResponse();
    const body = await res.json();
    expect(body.onboarding).toBe('https://jin.imajin.ai/.well-known/agent.json');
  });
});
