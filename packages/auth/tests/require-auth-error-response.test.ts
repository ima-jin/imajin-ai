/**
 * Tests for `authErrorResponse` / `agentCardUrl` (#1899) — the onboarding
 * discovery pointer attached to every AuthError produced by requireAuth() /
 * requireHardDID(), so a caller rejected with an unknown or ungranted key
 * learns where the agent card (and the knock flow it describes) lives.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { authErrorResponse, agentCardUrl } from '../src/require-auth';

const ENV_KEYS = ['APP_URL', 'NEXT_PUBLIC_BASE_URL', 'NEXT_PUBLIC_SERVICE_PREFIX', 'NEXT_PUBLIC_DOMAIN'] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('agentCardUrl', () => {
  it('defaults to https://imajin.ai/.well-known/agent.json with no env configured', () => {
    expect(agentCardUrl()).toBe('https://imajin.ai/.well-known/agent.json');
  });

  it('prefers an explicit APP_URL', () => {
    process.env.APP_URL = 'https://jin.imajin.ai';
    process.env.NEXT_PUBLIC_SERVICE_PREFIX = 'https://';
    process.env.NEXT_PUBLIC_DOMAIN = 'wrong.example';
    expect(agentCardUrl()).toBe('https://jin.imajin.ai/.well-known/agent.json');
  });

  it('resolves the single-domain service-prefix shape without doubling the host', () => {
    process.env.NEXT_PUBLIC_SERVICE_PREFIX = 'https://jin.imajin.ai/';
    process.env.NEXT_PUBLIC_DOMAIN = 'imajin.ai';
    expect(agentCardUrl()).toBe('https://jin.imajin.ai/.well-known/agent.json');
  });
});

describe('authErrorResponse', () => {
  it('preserves the original status and error message', async () => {
    const res = authErrorResponse({ error: 'Not authenticated', status: 401 });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Not authenticated');
  });

  it('preserves a 403 status unchanged', () => {
    const res = authErrorResponse({ error: 'Not authorized to act for this identity', status: 403 });
    expect(res.status).toBe(403);
  });

  it('attaches the onboarding pointer to the agent card', async () => {
    process.env.APP_URL = 'https://jin.imajin.ai';
    const res = authErrorResponse({ error: 'Not authenticated', status: 401 });
    const body = await res.json();
    expect(body.onboarding).toBe('https://jin.imajin.ai/.well-known/agent.json');
  });
});
