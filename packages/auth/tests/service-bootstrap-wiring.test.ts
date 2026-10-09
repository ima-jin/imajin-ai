/**
 * #2353 wiring guard: every userspace service that boots with a vault-sourced
 * ATTESTATION_INTERNAL_API_KEY must call `bootstrapInternalApiKey('<service>')`
 * from its `instrumentation.ts` register() hook, and its `.env.example` must no
 * longer ship `ATTESTATION_INTERNAL_API_KEY=` while documenting its own
 * bootstrap identity pair instead — unannotated, i.e. check-env REQUIRED.
 *
 * The bootstrap is wired inline in each app (there is no shared per-service
 * module), so a service that forgets it fails closed at runtime with every
 * kernel-internal call 401ing. Nothing else would catch that at CI time.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bootstrapInternalApiKey: vi.fn(async () => undefined),
}));

vi.mock('@imajin/logger/db', () => ({}));
vi.mock('@imajin/auth', () => ({
  bootstrapInternalApiKey: mocks.bootstrapInternalApiKey,
}));

const APPS_DIR = resolve(__dirname, '../../../apps');

// Apps that have an instrumentation.ts but must NOT load the vault key
// through @imajin/auth: the kernel hosts the vault and issues the key.
// (corpus has its own copy in src/lib/attestation-key.ts and no
// instrumentation.ts, so it never matches the scan below.)
const NOT_VAULT_CLIENTS = new Set(['kernel']);

// The service list is derived from the filesystem rather than hard-imported,
// so the test stays green whichever of this change and the `apps/links` / `apps/learn`
// prunes (#1986, PR #2422; #2503) merges first, and a newly added service with an
// instrumentation.ts is covered automatically instead of silently skipped.
const SERVICES = readdirSync(APPS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && !NOT_VAULT_CLIENTS.has(entry.name))
  .map((entry) => entry.name)
  .filter((name) => existsSync(resolve(APPS_DIR, name, 'instrumentation.ts')))
  .sort();

/** Absolute-path import (with @vite-ignore) so nothing is resolved at transform time. */
function loadInstrumentation(service: string): Promise<{ register: () => Promise<void> }> {
  return import(/* @vite-ignore */ resolve(APPS_DIR, service, 'instrumentation.ts'));
}

function readEnvExample(service: string): string[] {
  return readFileSync(resolve(APPS_DIR, service, '.env.example'), 'utf-8').split('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
});

it('discovers at least the services that remain after the apps/links and apps/learn prunes (#2422, #2503)', () => {
  // Floor guard: an empty or shrunken scan would make every case below vacuously pass.
  // `links` and `learn` are deliberately absent — both run from their own repos
  // now (they bootstrap their own identity), so they are covered only if present.
  expect(SERVICES).toEqual(expect.arrayContaining(['events', 'dykil', 'market', 'coffee']));
});

describe.each(SERVICES)('%s', (service) => {
  it('fetches the attestation key from the vault at boot under its own service name', async () => {
    const { register } = await loadInstrumentation(service);

    await register();

    expect(mocks.bootstrapInternalApiKey).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapInternalApiKey).toHaveBeenCalledWith(service);
  });

  it('does not bootstrap outside the node runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const { register } = await loadInstrumentation(service);

    await register();

    expect(mocks.bootstrapInternalApiKey).not.toHaveBeenCalled();
  });

  it('.env.example drops ATTESTATION_INTERNAL_API_KEY and documents its bootstrap identity pair', () => {
    const lines = readEnvExample(service);
    const upper = service.toUpperCase();

    expect(lines.some((line) => line.startsWith('ATTESTATION_INTERNAL_API_KEY='))).toBe(false);
    expect(lines.some((line) => line.startsWith(`${upper}_VAULT_BOOTSTRAP_DID=`))).toBe(true);
    expect(lines.some((line) => line.startsWith(`${upper}_VAULT_BOOTSTRAP_PRIVATE_KEY=`))).toBe(true);
  });

  it('.env.example leaves the bootstrap pair unannotated, so check-env treats it as required', () => {
    const lines = readEnvExample(service);
    const upper = service.toUpperCase();

    for (const name of [`${upper}_VAULT_BOOTSTRAP_DID`, `${upper}_VAULT_BOOTSTRAP_PRIVATE_KEY`]) {
      const index = lines.findIndex((line) => line.startsWith(`${name}=`));
      expect(index).toBeGreaterThan(0);
      expect(lines[index - 1]).not.toMatch(/^#\s*(optional|vault-sourced|deprecated)/);
    }
  });
});
