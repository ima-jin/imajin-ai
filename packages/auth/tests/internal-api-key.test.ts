/**
 * `bootstrapInternalApiKey` / `getInternalApiKey` (#2353): the shared,
 * vault-sourced `ATTESTATION_INTERNAL_API_KEY` boot helper every userspace
 * service (learn, events, links, dykil, market, coffee) calls from its
 * `instrumentation.ts`. Mirrors apps/corpus/src/lib/__tests__/attestation-key.test.ts:
 * real module state, faked kernel `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => mocks.log,
}));

import {
  _resetInternalApiKeyStateForTests,
  bootstrapInternalApiKey,
  getInternalApiKey,
  InternalApiKeyUnavailableError,
  internalApiKeyUnavailableError,
  markInternalApiKeyUsed,
  setInternalApiKeyResolver,
  vaultBootstrapNames,
} from '../src/internal-api-key';

const SERVICES = ['learn', 'events', 'links', 'dykil', 'market', 'coffee'] as const;

const PURPOSE = 'kernel.attestation-internal-api-key';
const GRANT_CMD = 'scripts/grant-attestation-internal-api-key.ts';
const PRIVATE_KEY = 'b'.repeat(64);
const VAULT_KEY_VALUE = 'deadbeef'.repeat(8);
const GRANT_ID = 'vdg_attestation_key_test';

const ENV_NAMES = SERVICES.flatMap((service) => {
  const names = vaultBootstrapNames(service);
  return [names.didEnv, names.privateKeyEnv];
});

function didFor(service: string): string {
  return `did:imajin:${service}-bootstrap00`;
}

function configureIdentity(service: string): void {
  const names = vaultBootstrapNames(service);
  process.env[names.didEnv] = didFor(service);
  process.env[names.privateKeyEnv] = PRIVATE_KEY;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function ackCalls(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit][] {
  return fetchMock.mock.calls.filter((call: unknown[]) => (call[0] as string).includes('/ack')) as [string, RequestInit][];
}

/** Fakes the kernel's challenge/authenticate/grants-list/fetch/ack quintet. */
function fakeKernelFetch(grants: unknown[] = [{ grantId: GRANT_ID, status: 'active' }]) {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/api/challenge')) return jsonResponse({ challengeId: 'ch_1', challenge: 'raw' });
    if (url.endsWith('/api/authenticate')) return jsonResponse({ token: 'imajin_tok_test' });
    if (url.includes('/api/vault/delegation/grants?purpose=')) return jsonResponse({ grants });
    if (url.includes('/fetch')) {
      return jsonResponse({ ok: true, field: `internal-secret:${PURPOSE}`, value: VAULT_KEY_VALUE });
    }
    if (url.includes('/ack')) return jsonResponse({ ok: true, grantId: GRANT_ID, outcome: 'used', ackedAt: new Date().toISOString() });
    throw new Error(`unexpected fetch to ${url}`);
  });
}

function loggedText(): string {
  const calls = [...mocks.log.error.mock.calls, ...mocks.log.warn.mock.calls, ...mocks.log.info.mock.calls];
  return JSON.stringify(calls);
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetInternalApiKeyStateForTests();
  process.env.AUTH_SERVICE_URL = 'https://kernel.test';
});

afterEach(() => {
  vi.unstubAllGlobals();
  _resetInternalApiKeyStateForTests();
  delete process.env.AUTH_SERVICE_URL;
  for (const name of ENV_NAMES) delete process.env[name];
});

describe('vaultBootstrapNames', () => {
  it.each(SERVICES)('derives %s bootstrap env names and a distinct purpose label', (service) => {
    const upper = service.toUpperCase();
    expect(vaultBootstrapNames(service)).toEqual({
      didEnv: `${upper}_VAULT_BOOTSTRAP_DID`,
      privateKeyEnv: `${upper}_VAULT_BOOTSTRAP_PRIVATE_KEY`,
      purpose: `${service}.boot.attestation-key`,
    });
  });
});

describe('bootstrapInternalApiKey — vault has the grant', () => {
  it.each(SERVICES)('%s fetches the key by purpose using its own bootstrap identity', async (service) => {
    configureIdentity(service);
    const fetchMock = fakeKernelFetch();
    vi.stubGlobal('fetch', fetchMock);

    await expect(bootstrapInternalApiKey(service)).resolves.toBe('loaded');

    expect(await getInternalApiKey()).toBe(VAULT_KEY_VALUE);
    const authCall = fetchMock.mock.calls.find((call) => (call[0] as string).endsWith('/api/authenticate'));
    expect(JSON.parse((authCall?.[1] as RequestInit).body as string).id).toBe(didFor(service));
    const grantsCall = fetchMock.mock.calls.find((call) => (call[0] as string).includes('/grants?purpose='));
    expect(decodeURIComponent(grantsCall?.[0] as string)).toContain(`purpose=${PURPOSE}`);
    expect(mocks.log.error).not.toHaveBeenCalled();
  });

  it('never logs the fetched key value', async () => {
    configureIdentity('learn');
    vi.stubGlobal('fetch', fakeKernelFetch());

    await bootstrapInternalApiKey('learn');

    expect(loggedText()).not.toContain(VAULT_KEY_VALUE);
    expect(loggedText()).not.toContain(PRIVATE_KEY);
  });

  it('defers the used-ack to first use and sends it exactly once', async () => {
    configureIdentity('events');
    const fetchMock = fakeKernelFetch();
    vi.stubGlobal('fetch', fetchMock);
    await bootstrapInternalApiKey('events');
    expect(ackCalls(fetchMock)).toHaveLength(0);

    markInternalApiKeyUsed();
    markInternalApiKeyUsed();

    await vi.waitFor(() => expect(ackCalls(fetchMock)).toHaveLength(1));
    expect(JSON.parse(ackCalls(fetchMock)[0][1].body as string).outcome).toBe('used');
  });

  it('is visible to a freshly re-imported module copy (state is process-global, not per-bundle)', async () => {
    configureIdentity('market');
    vi.stubGlobal('fetch', fakeKernelFetch());
    await bootstrapInternalApiKey('market');

    vi.resetModules();
    const fresh = await import('../src/internal-api-key');

    expect(await fresh.getInternalApiKey()).toBe(VAULT_KEY_VALUE);
  });
});

describe('bootstrapInternalApiKey — fails closed with one clear ERROR', () => {
  it('identity not configured: names the env vars, purpose and operator command, and never calls the vault', async () => {
    const fetchMock = fakeKernelFetch();
    vi.stubGlobal('fetch', fetchMock);

    await expect(bootstrapInternalApiKey('dykil')).resolves.toBe('unresolved');

    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getInternalApiKey()).toBeNull();
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    const [meta, message] = mocks.log.error.mock.calls[0];
    expect(meta).toMatchObject({ service: 'dykil', purpose: PURPOSE });
    expect(message).toContain('DYKIL_VAULT_BOOTSTRAP_DID');
    expect(message).toContain(PURPOSE);
    expect(message).toContain(`${GRANT_CMD} <service-did>`);
  });

  it('no active grant yet: names the service DID, purpose and the exact grant command for that DID', async () => {
    configureIdentity('coffee');
    vi.stubGlobal('fetch', fakeKernelFetch([]));

    await expect(bootstrapInternalApiKey('coffee')).resolves.toBe('unresolved');

    expect(await getInternalApiKey()).toBeNull();
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    const [meta, message] = mocks.log.error.mock.calls[0];
    expect(meta).toMatchObject({ service: 'coffee', did: didFor('coffee'), purpose: PURPOSE });
    expect(message).toContain(didFor('coffee'));
    expect(message).toContain(PURPOSE);
    expect(message).toContain(`${GRANT_CMD} ${didFor('coffee')}`);
  });

  it('vault unreachable: does not throw, logs one error, leaves no key', async () => {
    configureIdentity('links');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    await expect(bootstrapInternalApiKey('links')).resolves.toBe('unresolved');

    expect(await getInternalApiKey()).toBeNull();
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
    expect(mocks.log.error.mock.calls[0][1]).toContain(`${GRANT_CMD} ${didFor('links')}`);
  });

  it('a later successful boot clears the recorded failure', async () => {
    configureIdentity('learn');
    vi.stubGlobal('fetch', fakeKernelFetch([]));
    await bootstrapInternalApiKey('learn');
    vi.stubGlobal('fetch', fakeKernelFetch());

    await expect(bootstrapInternalApiKey('learn')).resolves.toBe('loaded');

    expect(await getInternalApiKey()).toBe(VAULT_KEY_VALUE);
    expect(internalApiKeyUnavailableError().message).toContain('has been resolved');
  });
});

describe('getInternalApiKey / resolver', () => {
  it('is null when nothing was resolved', async () => {
    expect(await getInternalApiKey()).toBeNull();
  });

  it('falls back to a registered resolver (the kernel path)', async () => {
    setInternalApiKeyResolver(async () => 'kernel-owned-key');

    expect(await getInternalApiKey()).toBe('kernel-owned-key');
  });

  it('prefers the boot-fetched key over a registered resolver', async () => {
    configureIdentity('learn');
    vi.stubGlobal('fetch', fakeKernelFetch());
    setInternalApiKeyResolver(() => 'kernel-owned-key');

    await bootstrapInternalApiKey('learn');

    expect(await getInternalApiKey()).toBe(VAULT_KEY_VALUE);
  });

  it('treats an empty resolver value as unavailable, never as an empty key', async () => {
    setInternalApiKeyResolver(() => '');

    expect(await getInternalApiKey()).toBeNull();
  });

  it('treats a throwing resolver as unavailable and logs the failure', async () => {
    setInternalApiKeyResolver(() => { throw new Error('vault down'); });

    expect(await getInternalApiKey()).toBeNull();
    expect(mocks.log.error).toHaveBeenCalledTimes(1);
  });
});

describe('InternalApiKeyUnavailableError', () => {
  it('names the purpose and the placeholder operator command when boot never ran', () => {
    const err = internalApiKeyUnavailableError();

    expect(err).toBeInstanceOf(InternalApiKeyUnavailableError);
    expect(err.message).toContain(PURPOSE);
    expect(err.message).toContain(`${GRANT_CMD} <service-did>`);
  });

  it('names the failed service and its DID after a failed boot', async () => {
    configureIdentity('events');
    vi.stubGlobal('fetch', fakeKernelFetch([]));
    await bootstrapInternalApiKey('events');

    const err = internalApiKeyUnavailableError();

    expect(err.message).toContain('events could not resolve');
    expect(err.message).toContain(`${GRANT_CMD} ${didFor('events')}`);
  });
});
