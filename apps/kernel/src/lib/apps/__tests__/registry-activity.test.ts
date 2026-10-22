import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ insert: vi.fn(), values: vi.fn() }));
vi.mock('@/src/db', () => ({
  systemEvents: 'events-only', db: { insert: mocks.insert },
}));
vi.mock('@/src/lib/kernel/id', () => ({ generateId: () => 'fixture-event' }));
import { recordRegistryActivity } from '../registry-activity';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.insert.mockReturnValue({ values: mocks.values });
});
describe('metadata-only activity', () => {
  it.each(['app.token.minted', 'app.authorization.validated'] as const)('records %s without any registry write or credential fields', async action => {
    await recordRegistryActivity('did:imajin:fixture', action);
    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert).toHaveBeenCalledWith('events-only');
    expect(mocks.values).toHaveBeenCalledTimes(1);
    expect(mocks.values).toHaveBeenCalledWith({
      id: 'fixture-event', service: 'auth', action, did: 'did:imajin:fixture',
    });
  });
  it('keeps ledger failure out of the successful authentication path', async () => {
    mocks.values.mockRejectedValue(new Error('provider detail'));
    await expect(recordRegistryActivity('did:imajin:fixture', 'app.token.minted')).resolves.toBeUndefined();
  });
});
