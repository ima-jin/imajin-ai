import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateOnboardTickets } from '../onboard-tickets';

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), fetch: vi.fn() }));
vi.mock('@/src/lib/apps/registry-url', () => ({ resolveRegistryAppBaseUrl: mocks.resolve }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', mocks.fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe('optional registered events migration', () => {
  it('uses the registered base once, not a port hint or duplicate /events prefix', async () => {
    mocks.resolve.mockResolvedValue('https://node.test/events');
    mocks.fetch.mockResolvedValue(new Response(null, { status: 204 }));
    await migrateOnboardTickets('person@example.test', 'did:imajin:person');
    expect(mocks.resolve).toHaveBeenCalledWith('events');
    expect(mocks.fetch).toHaveBeenCalledWith('https://node.test/events/api/migrate-tickets', expect.objectContaining({
      method: 'POST', redirect: 'error',
      body: JSON.stringify({ email: 'person@example.test', hardDid: 'did:imajin:person' }),
    }));
  });
  it('skips an unregistered app instead of contacting a guessed deployment', async () => {
    mocks.resolve.mockResolvedValue(null);
    await migrateOnboardTickets('person@example.test', 'did:imajin:person');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it('lets the fire-and-forget caller handle registry errors', async () => {
    mocks.resolve.mockRejectedValue(new Error('unavailable'));
    await expect(migrateOnboardTickets('person@example.test', 'did:imajin:person')).rejects.toThrow('unavailable');
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
