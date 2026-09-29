/**
 * #2353 wiring guard: each of the six userspace services must call
 * `bootstrapInternalApiKey('<service>')` from its `instrumentation.ts`
 * register() hook, and its `.env.example` must no longer ship
 * `ATTESTATION_INTERNAL_API_KEY=` (it is vault-sourced) while documenting its
 * own bootstrap identity pair instead — unannotated, i.e. check-env REQUIRED.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bootstrapInternalApiKey: vi.fn(async () => 'loaded'),
}));

vi.mock('@imajin/logger/db', () => ({}));
vi.mock('@imajin/auth', () => ({
  bootstrapInternalApiKey: mocks.bootstrapInternalApiKey,
}));

// Services that exist on disk right now. `apps/links` is being pruned from
// the kernel repo (#1986, PR #2422); deriving the list from the filesystem
// keeps this test green whichever of that PR and #2353 merges first, instead
// of hard-importing a directory that may no longer exist.
const APPS_DIR = resolve(__dirname, '../../../apps');
const CANDIDATE_SERVICES = ['learn', 'events', 'links', 'dykil', 'market', 'coffee'] as const;
const SERVICES = CANDIDATE_SERVICES.filter((service) => existsSync(resolve(APPS_DIR, service, 'instrumentation.ts')));

/** Absolute-path import (with @vite-ignore) so a pruned app is never resolved at transform time. */
function loadInstrumentation(service: string): Promise<{ register: () => Promise<void> }> {
  return import(/* @vite-ignore */ resolve(APPS_DIR, service, 'instrumentation.ts'));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
});

it('covers at least the services that remain after the apps/links prune (#2422)', () => {
  expect(SERVICES).toEqual(expect.arrayContaining(['learn', 'events', 'dykil', 'market', 'coffee']));
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
    const example = readFileSync(resolve(APPS_DIR, service, '.env.example'), 'utf-8');
    const upper = service.toUpperCase();

    expect(example).not.toMatch(/^ATTESTATION_INTERNAL_API_KEY=/m);
    expect(example).toMatch(new RegExp(`^${upper}_VAULT_BOOTSTRAP_DID=`, 'm'));
    expect(example).toMatch(new RegExp(`^${upper}_VAULT_BOOTSTRAP_PRIVATE_KEY=`, 'm'));
  });

  it('.env.example leaves the bootstrap pair unannotated, so check-env treats it as required', () => {
    const lines = readFileSync(resolve(APPS_DIR, service, '.env.example'), 'utf-8').split('\n');
    const upper = service.toUpperCase();

    for (const name of [`${upper}_VAULT_BOOTSTRAP_DID`, `${upper}_VAULT_BOOTSTRAP_PRIVATE_KEY`]) {
      const index = lines.findIndex((line) => line.startsWith(`${name}=`));
      expect(index).toBeGreaterThan(0);
      expect(lines[index - 1]).not.toMatch(/^#\s*(optional|vault-sourced|deprecated)/);
    }
  });
});
