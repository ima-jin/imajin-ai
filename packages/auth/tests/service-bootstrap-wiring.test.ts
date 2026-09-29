/**
 * #2353 wiring guard: each of the six userspace services must call
 * `bootstrapInternalApiKey('<service>')` from its `instrumentation.ts`
 * register() hook, and its `.env.example` must no longer ship
 * `ATTESTATION_INTERNAL_API_KEY=` (it is vault-sourced) while documenting its
 * own bootstrap identity pair instead.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bootstrapInternalApiKey: vi.fn(async () => 'loaded'),
}));

vi.mock('@imajin/logger/db', () => ({}));
vi.mock('@imajin/auth', () => ({
  bootstrapInternalApiKey: mocks.bootstrapInternalApiKey,
}));

const REGISTER_LOADERS = {
  learn: () => import('../../../apps/learn/instrumentation'),
  events: () => import('../../../apps/events/instrumentation'),
  links: () => import('../../../apps/links/instrumentation'),
  dykil: () => import('../../../apps/dykil/instrumentation'),
  market: () => import('../../../apps/market/instrumentation'),
  coffee: () => import('../../../apps/coffee/instrumentation'),
} as const;

const SERVICES = Object.keys(REGISTER_LOADERS) as (keyof typeof REGISTER_LOADERS)[];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_RUNTIME', 'nodejs');
});

describe.each(SERVICES)('%s', (service) => {
  it('fetches the attestation key from the vault at boot under its own service name', async () => {
    const { register } = await REGISTER_LOADERS[service]();

    await register();

    expect(mocks.bootstrapInternalApiKey).toHaveBeenCalledTimes(1);
    expect(mocks.bootstrapInternalApiKey).toHaveBeenCalledWith(service);
  });

  it('does not bootstrap outside the node runtime', async () => {
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    const { register } = await REGISTER_LOADERS[service]();

    await register();

    expect(mocks.bootstrapInternalApiKey).not.toHaveBeenCalled();
  });

  it('.env.example drops ATTESTATION_INTERNAL_API_KEY and documents its bootstrap identity pair', () => {
    const example = readFileSync(resolve(__dirname, `../../../apps/${service}/.env.example`), 'utf-8');
    const upper = service.toUpperCase();

    expect(example).not.toMatch(/^ATTESTATION_INTERNAL_API_KEY=/m);
    expect(example).toMatch(new RegExp(`^${upper}_VAULT_BOOTSTRAP_DID=`, 'm'));
    expect(example).toMatch(new RegExp(`^${upper}_VAULT_BOOTSTRAP_PRIVATE_KEY=`, 'm'));
  });
});
