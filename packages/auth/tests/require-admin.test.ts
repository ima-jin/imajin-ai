import { beforeEach, describe, expect, it, vi } from 'vitest';
const session = vi.hoisted(() => vi.fn());
vi.mock('../src/session', () => ({ getSession: session }));
import { requireAdmin } from '../src/require-admin';

beforeEach(() => {
  vi.stubEnv('NODE_DID', 'did:imajin:node-test');
});
describe('rotation routes reuse the existing admin boundary', () => {
  it.each([null, {}, { did: 'did:imajin:owner' },
    { did: 'did:imajin:owner', actingAs: 'did:imajin:ordinary-app' }])(
    'rejects missing node act-as, including ordinary app act-as', async (value) => {
      session.mockResolvedValue(value);
      expect(await requireAdmin()).toBeNull();
      vi.unstubAllEnvs();
    },
  );
  it('preserves the existing node act-as admin gate', async () => {
    session.mockResolvedValue({ actingAs: 'did:imajin:node-test' });
    expect(Boolean(await requireAdmin())).toBe(true);
    vi.unstubAllEnvs();
  });
  it('fails closed if node DID is absent', async () => {
    vi.stubEnv('NODE_DID', '');
    session.mockResolvedValue({ actingAs: 'did:imajin:node-test' });
    expect(await requireAdmin()).toBeNull();
    vi.unstubAllEnvs();
  });
});
