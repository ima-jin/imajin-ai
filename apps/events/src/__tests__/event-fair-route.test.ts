import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildFairManifest } from '../../../../packages/fair/src/buildManifest';
import {
  storedDocumentManifest,
  storedFeeManifest,
} from '../../../../packages/fair/tests/fixtures/stored-manifests';

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  organizer: vi.fn(),
  policy: vi.fn(),
  select: vi.fn(),
  limit: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  returning: vi.fn(),
  revalidate: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn() }),
}));
vi.mock('@imajin/auth', () => ({
  requireAuth: mocks.requireAuth,
  resolveActingDid: (identity: { id: string }) => identity.id,
}));
vi.mock('@imajin/auth/delegation-policy', () => ({
  enforceRoutePolicy: mocks.policy,
}));
vi.mock('@/src/lib/organizer', () => ({
  isEventOrganizer: mocks.organizer,
}));
vi.mock('next/cache', () => ({ revalidatePath: mocks.revalidate }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));
vi.mock('@/src/db', () => ({
  db: { select: mocks.select, update: mocks.update },
  events: { id: 'events.id' },
}));

import { PATCH } from '../../app/api/events/[id]/fair/route';

const event = { id: 'evt_manifest', metadata: { title: 'Stored event', custom: { preserved: true } } };
const routeParams = { params: Promise.resolve({ id: event.id }) };

function request(manifest: unknown) {
  return new Request(`https://events.test/api/events/${event.id}/fair`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest }),
  }) as never;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAuth.mockResolvedValue({ identity: { id: 'did:imajin:organizer' } });
  mocks.organizer.mockResolvedValue({ authorized: true });
  mocks.policy.mockReturnValue(null);
  mocks.limit.mockResolvedValue([structuredClone(event)]);
  mocks.select.mockReturnValue({
    from: () => ({ where: () => ({ limit: mocks.limit }) }),
  });
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: () => ({ returning: mocks.returning }) });
  mocks.returning.mockResolvedValue([{ id: event.id }]);
});

describe('PATCH event .fair manifest — supported shape persistence (#2787)', () => {
  it.each([
    ['built fee', buildFairManifest({
      creatorDid: 'did:imajin:organizer',
      contentDid: 'did:imajin:event',
      contentType: 'event',
    })],
    ['stored fee', storedFeeManifest],
    ['stored document', storedDocumentManifest],
  ])('accepts and persists %s unchanged without a migration', async (_name, manifest) => {
    const before = JSON.stringify(manifest);
    const response = await PATCH(request(manifest), routeParams);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.manifest).toEqual(manifest);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith({
      metadata: { ...event.metadata, fair: manifest },
      updatedAt: expect.any(Date),
    });
    expect(JSON.stringify(mocks.set.mock.calls[0][0].metadata.fair)).toBe(before);
    expect(JSON.stringify(manifest)).toBe(before);
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledWith(`/${event.id}`);
  });

  it.each([
    ['fee missing required chain', { ...storedFeeManifest, chain: undefined }],
    ['fee with incorrect share total', { ...storedFeeManifest, distributions: [{ did: 'did:test', role: 'creator', share: 0.5 }] }],
    ['document missing owner', { ...storedDocumentManifest, owner: undefined }],
    ['document with null transfer', { ...storedDocumentManifest, transfer: null }],
    ['hybrid markers', { ...storedDocumentManifest, version: '0.4.0' }],
  ])('rejects %s with 400 and never writes', async (_name, manifest) => {
    const response = await PATCH(request(manifest), routeParams);
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe('Invalid .fair manifest');
    expect(body.errors.length).toBeGreaterThan(0);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.set).not.toHaveBeenCalled();
    expect(mocks.returning).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
