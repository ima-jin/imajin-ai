import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock('@imajin/auth', () => ({ requireAuth: mocks.auth }));
vi.mock('@/src/db', () => ({ db: {}, attestationSignatures: {} }));
vi.mock('../group-membership', () => ({ isActiveGroupMember: vi.fn() }));
import { requireDocumentActor } from '../document-authorization';

const request = new Request('http://localhost');
beforeEach(() => vi.clearAllMocks());

describe('canonical document authority', () => {
  it('always requires the auth service and an actual session', async () => {
    mocks.auth.mockResolvedValue({ identity: { id: 'did:imajin:human' } });
    expect(await requireDocumentActor(request, { write: true })).toEqual({
      effectiveDid: 'did:imajin:human', actingHumanDid: 'did:imajin:human',
    });
    expect(mocks.auth).toHaveBeenCalledWith(request, { service: 'auth', sessionOnly: true });
  });
  it.each([
    { subtype: 'agent' },
    { actingFor: 'did:imajin:principal' },
    { actingAs: 'did:imajin:org', actingAsRole: 'maintainer' },
    { actingAs: 'did:imajin:org', actingAsRole: 'member' },
    { actingAs: 'did:imajin:org' },
  ])('rejects unauthorized document mutation authority (%j)', async (overlay) => {
    mocks.auth.mockResolvedValue({ identity: { id: 'did:imajin:human', ...overlay } });
    const result = await requireDocumentActor(request, { write: true });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });
  it.each(['owner', 'admin'])('preserves the human when selecting org authority (%s)', async (actingAsRole) => {
    mocks.auth.mockResolvedValue({ identity: { id: 'did:imajin:human', actingAs: 'did:imajin:org', actingAsRole } });
    expect(await requireDocumentActor(request, { write: true })).toEqual({
      effectiveDid: 'did:imajin:org', actingHumanDid: 'did:imajin:human',
    });
  });
  it('retains the canonical denial rather than falling back to the personal DID', async () => {
    mocks.auth.mockResolvedValue({ error: 'Service denied', status: 403 });
    const result = await requireDocumentActor(request);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    expect(await (result as Response).json()).toEqual({ error: 'Service denied' });
  });
});
