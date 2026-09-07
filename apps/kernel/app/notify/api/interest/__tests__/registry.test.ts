/**
 * `resolveScopeForAttestation()` / `didInterestExists()` / `createDidInterest()` (#2061):
 * each hits the registry via the shared `registryServiceUrl()` helper and
 * short-circuits with a safe default (warn+null / false / warn+skip) when
 * neither `REGISTRY_SERVICE_URL` nor the deprecated `REGISTRY_URL` is set.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => mocks.log,
}));

const ENV_KEYS = ['REGISTRY_SERVICE_URL', 'REGISTRY_URL', 'PORT'] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

const SECRET = 'webhook-secret';

describe('resolveScopeForAttestation', () => {
  it('warns and returns null without calling fetch when the registry URL is not configured', async () => {
    const { resolveScopeForAttestation } = await import('../registry');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolveScopeForAttestation('intro.completed', SECRET)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
  });

  it('fetches the interest catalog and returns the matching scope when configured', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { resolveScopeForAttestation } = await import('../registry');
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ interests: [{ scope: 'events', triggers: ['intro.completed'] }] }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    expect(await resolveScopeForAttestation('intro.completed', SECRET)).toBe('events');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7000/registry/api/interests',
      expect.objectContaining({ headers: { 'x-webhook-secret': SECRET } }),
    );
  });

  it('returns null and logs an error on a non-2xx response', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { resolveScopeForAttestation } = await import('../registry');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 500 })));

    expect(await resolveScopeForAttestation('intro.completed', SECRET)).toBeNull();
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
  });
});

describe('didInterestExists', () => {
  it('returns false without calling fetch when the registry URL is not configured', async () => {
    const { didInterestExists } = await import('../registry');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await didInterestExists('did:imajin:jin', 'events', SECRET)).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches preferences and returns true when the scope is already present', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { didInterestExists } = await import('../registry');
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ interests: [{ scope: 'events' }] }),
      { status: 200 },
    ));
    vi.stubGlobal('fetch', fetchMock);

    expect(await didInterestExists('did:imajin:jin', 'events', SECRET)).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7000/registry/api/preferences/did%3Aimajin%3Ajin',
      expect.objectContaining({ headers: { 'x-webhook-secret': SECRET } }),
    );
  });
});

describe('createDidInterest', () => {
  it('warns and skips the POST when the registry URL is not configured', async () => {
    const { createDidInterest } = await import('../registry');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await createDidInterest('did:imajin:jin', 'events', 'intro.completed', SECRET);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
  });

  it('POSTs the new did_interest row to the resolved registry URL when configured', async () => {
    process.env.REGISTRY_SERVICE_URL = 'http://localhost:7000/registry';
    const { createDidInterest } = await import('../registry');
    const fetchMock = vi.fn(async () => new Response(null, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    await createDidInterest('did:imajin:jin', 'events', 'intro.completed', SECRET);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:7000/registry/api/preferences/did%3Aimajin%3Ajin/interests/events',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ createdByAttestation: 'intro.completed' }),
      }),
    );
  });
});
