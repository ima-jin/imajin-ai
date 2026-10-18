import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), policy: vi.fn(), block: vi.fn(), rows: vi.fn(), update: vi.fn(),
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: (...args: unknown[]) => mocks.auth(...args),
  resolveActingDid: (identity: { id: string }) => identity.id,
}));
vi.mock('@imajin/auth/delegation-policy', () => ({ enforceRoutePolicy: (...args: unknown[]) => mocks.policy(...args) }));
vi.mock('@imajin/bus', () => ({ publish: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({ prepareMechanicalAttestation: vi.fn() }));
vi.mock('@/src/lib/auth/foreign-agent-stub', () => ({ blockForeignAgentStub: (...args: unknown[]) => mocks.block(...args) }));
vi.mock('@/src/db', () => {
  const where = () => ({ returning: mocks.rows });
  const set = () => ({ where });
  return {
    connections: { didA: 'a', didB: 'b' },
    db: { update: (...args: unknown[]) => {
      mocks.update(...args);
      return { set };
    } },
  };
});
import { DELETE } from '../route';

const principal = 'did:imajin:ryan';
const sender = 'did:web:agent.example';
function remove() {
  return DELETE(new NextRequest('https://imajin.ai/connections/api/connections/sender', { method: 'DELETE' }), {
    params: Promise.resolve({ did: sender }),
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.mockResolvedValue({ identity: { id: principal } });
  mocks.policy.mockReturnValue(null);
  mocks.rows.mockResolvedValue([]);
  mocks.block.mockResolvedValue(true);
});
describe('operator sender block (#2590)', () => {
  it('blocks a stranger without requiring a connection and waits for revocation', async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(mocks.block).toHaveBeenCalledWith(sender, principal);
    expect(await response.json()).toEqual({ disconnected: true });
  });
  it('never lets an unauthenticated caller revoke a credential', async () => {
    mocks.auth.mockResolvedValue({ error: 'Unauthorized', status: 401 });
    expect((await remove()).status).toBe(401);
    expect(mocks.block).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it('honors delegated route policy before any write', async () => {
    mocks.policy.mockReturnValue(new Response(null, { status: 403 }));
    expect((await remove()).status).toBe(403);
    expect(mocks.block).not.toHaveBeenCalled();
  });
  it('preserves connection-not-found for unrelated identities', async () => {
    mocks.block.mockResolvedValue(false);
    expect((await remove()).status).toBe(404);
  });
  it('preserves normal disconnect for existing connections', async () => {
    mocks.rows.mockResolvedValue([{ id: 'connection' }]);
    mocks.block.mockResolvedValue(false);
    expect((await remove()).status).toBe(200);
  });
  it('does not acknowledge a block when durable revocation fails', async () => {
    mocks.block.mockRejectedValue(new Error('storage unavailable'));
    await expect(remove()).rejects.toThrow('storage unavailable');
  });
});
