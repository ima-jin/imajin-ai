import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ─────────────────────────────────────────────────────────────────
//
// #2360: one delegation rule for every owner-mutation route. This suite drives
// each *class* of media route through the real policy helper (the helper and
// registry are deliberately NOT mocked) with an `X-Acting-For` delegate and
// with the owner, proving a delegate may propose but never execute
// irreversible / value-moving mutations, and may execute reversible ones.
// Everything the handlers touch AFTER the gate is stubbed out: if the gate
// holds, none of it is reached.

const mockSelect = vi.hoisted(() => vi.fn());
const mockUpdate = vi.hoisted(() => vi.fn());
const mockInsert = vi.hoisted(() => vi.fn());

vi.mock('@/src/db', () => ({
  db: { select: mockSelect, update: mockUpdate, insert: mockInsert, delete: vi.fn() },
  assets: {},
  settlements: {},
  identities: {},
  assetReferences: {},
}));

vi.mock('drizzle-orm', () => ({ eq: vi.fn(), and: vi.fn(), gte: vi.fn(), sql: vi.fn() }));

const mockRequireAuth = vi.hoisted(() => vi.fn());
vi.mock('@imajin/auth', () => ({
  requireAuth: mockRequireAuth,
  resolveActingDid: (identity: { actingFor?: string; actingAs?: string; id: string }) =>
    identity.actingFor ?? identity.actingAs ?? identity.id,
  canonicalize: vi.fn(),
  verifyAppToken: vi.fn(async () => null),
}));

vi.mock('@imajin/fair', () => ({
  isFairManifestV11: vi.fn(() => false),
  validateManifest: vi.fn(),
  upgradeToV1_1: vi.fn(),
  canonicalize: vi.fn(),
}));
vi.mock('@imajin/logger', () => ({
  createLogger: vi.fn(() => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })),
}));
vi.mock('@imajin/bus', () => ({ publish: vi.fn() }));
vi.mock('@imajin/dfos', () => ({ publishContentEvent: vi.fn() }));
vi.mock('nanoid', () => ({ nanoid: vi.fn(() => 'nano') }));
vi.mock('@/src/lib/http/node-url', () => ({ nodeUrl: vi.fn(() => 'https://jin.test') }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: vi.fn() }));
vi.mock('@/src/lib/kernel/sign-fair-manifest', () => ({ signFairAsNode: vi.fn() }));
vi.mock('@/src/lib/kernel/cors', () => ({ corsHeaders: vi.fn(() => ({})), corsOptions: vi.fn() }));
vi.mock('@/src/lib/media/manifest-helpers', () => ({ writeManifestToDisk: vi.fn(), updateManifestFlow: vi.fn() }));
vi.mock('@/src/lib/media/render-fair-html', () => ({ renderFairHtml: vi.fn() }));
vi.mock('@/src/lib/media/read-access', () => ({ getAccessType: vi.fn() }));
vi.mock('@/src/lib/media/authorize-read', () => ({ authorizeAssetRead: vi.fn() }));
vi.mock('@/src/lib/media/apply-grants', () => ({ applyGrants: vi.fn() }));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn(), writeFile: vi.fn(), unlink: vi.fn(), rename: vi.fn() }));

import { isFairManifestV11 } from '@imajin/fair';
import { POST as upgradeFair } from '@/app/media/api/assets/[id]/upgrade-fair/route';
import { POST as settle } from '@/app/media/api/assets/[id]/settle/route';
import { POST as settleConfirm } from '@/app/media/api/assets/[id]/settle/confirm/route';
import { PUT as putFair } from '@/app/media/api/assets/[id]/fair/route';
import { PATCH as patchAccess } from '@/app/media/api/assets/[id]/access/route';
import { PATCH as patchGrants } from '@/app/media/api/assets/[id]/grants/route';
import { POST as historyGrant } from '@/app/media/api/workspace/history-grant/route';
import { PATCH as patchArticle } from '@/app/media/api/assets/[id]/article/route';
import { POST as classify } from '@/app/media/api/assets/[id]/classify/route';
import { PUT as putFolders } from '@/app/media/api/assets/[id]/folders/route';

// ─── Fixtures ──────────────────────────────────────────────────────────────

const OWNER = 'did:imajin:owner';
const AGENT = 'did:imajin:agent';
const params = Promise.resolve({ id: 'asset_test' });

type Handler = (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

function makeRequest(method: string, body: unknown = {}): NextRequest {
  return new Request('https://test.imajin.ai/media/api/assets/asset_test', {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

/** A drizzle-style `select().from().where().limit()` chain resolving to `rows`. */
function selectChain(rows: unknown[]) {
  const limit = async () => rows;
  const where = () => ({ limit });
  return { from: () => ({ where }) };
}

function asDelegate() {
  mockRequireAuth.mockResolvedValueOnce({ identity: { id: AGENT, scope: 'actor', actingFor: OWNER } });
}
function asOwner() {
  mockRequireAuth.mockResolvedValueOnce({ identity: { id: OWNER, scope: 'actor' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps queued `...Once` results — reset so a stale identity
  // from one test can never leak into the next.
  mockRequireAuth.mockReset();
  // Any DB read resolves to "no such asset" — the owner path then ends in a 404,
  // which is all these tests need to tell "past the gate" from "stopped at it".
  mockSelect.mockReturnValue(selectChain([]));
});

// ─── value-moving ──────────────────────────────────────────────────────────

const VALUE_MOVING: Array<[string, string, Handler, string]> = [
  ['POST settle/confirm', 'settle-confirm', settleConfirm as Handler, 'POST'],
  ['PUT fair', 'fair-update', putFair as Handler, 'PUT'],
];

describe('value-moving class — settle, settle/confirm, .fair split edits', () => {
  it.each(VALUE_MOVING)('%s refuses a delegate and reads nothing', async (_label, action, handler, method) => {
    asDelegate();

    const res = await handler(makeRequest(method), { params });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'AGENT_APPROVAL_REQUIRED',
      action,
      class: 'value-moving',
      resourceId: 'asset_test',
      ownerDid: OWNER,
      delegateDid: AGENT,
    });
    expect(mockSelect).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });
});

describe('value-moving class — settle (buyer-initiated)', () => {
  it('POST settle refuses a delegate and writes no settlement row', async () => {
    // settle validates the body and loads a priced .fair manifest BEFORE auth
    // (receipts are buyer-bound), so give it one to get as far as the gate.
    vi.mocked(isFairManifestV11).mockReturnValueOnce(true);
    mockSelect.mockReturnValueOnce(
      selectChain([
        { id: 'asset_test', status: 'active', fairManifest: { distribution: { reproduction: { price: { amount: 1 } } } } },
      ]),
    );
    asDelegate();

    const res = await settle(makeRequest('POST', { scheme: 'mjnx-direct' }), { params });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      code: 'AGENT_APPROVAL_REQUIRED',
      action: 'settle',
      class: 'value-moving',
      ownerDid: OWNER,
      delegateDid: AGENT,
    });
    expect(mockInsert).not.toHaveBeenCalled();
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// ─── irreversible ──────────────────────────────────────────────────────────

describe('irreversible class — .fair upgrade, access, grants, history-grant', () => {
  it('POST upgrade-fair refuses a delegate and reads nothing', async () => {
    asDelegate();

    const res = await upgradeFair(makeRequest('POST'), { params });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED', action: 'upgrade-fair', class: 'irreversible' });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('POST upgrade-fair lets the owner countersign — the request reaches the asset lookup', async () => {
    asOwner();

    const res = await upgradeFair(makeRequest('POST'), { params });

    // Past the gate: the handler looked the asset up (stubbed empty → not the owner's).
    expect(await res.json()).not.toHaveProperty('code', 'AGENT_APPROVAL_REQUIRED');
    expect(mockSelect).toHaveBeenCalled();
  });

  it('PATCH access refuses a delegate on the session path', async () => {
    asDelegate();

    const res = await patchAccess(makeRequest('PATCH'), { params });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED', action: 'access', class: 'irreversible' });
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it('PATCH grants refuses a delegate', async () => {
    asDelegate();

    const res = await patchGrants(makeRequest('PATCH'), { params });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED', action: 'grants', class: 'irreversible' });
  });

  it('POST workspace/history-grant refuses a delegate', async () => {
    asDelegate();

    const res = await historyGrant(makeRequest('POST'));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'AGENT_APPROVAL_REQUIRED', action: 'history-grant', class: 'irreversible' });
    expect(mockSelect).not.toHaveBeenCalled();
  });
});

// ─── reversible ────────────────────────────────────────────────────────────

const REVERSIBLE: Array<[string, Handler, string]> = [
  ['PATCH article', patchArticle as Handler, 'PATCH'],
  ['POST classify', classify as Handler, 'POST'],
  ['PUT folders', putFolders as Handler, 'PUT'],
];

describe('reversible class — metadata a delegate may execute', () => {
  it.each(REVERSIBLE)('%s is not refused for a delegate (it proceeds past the gate)', async (_label, handler, method) => {
    asDelegate();

    const res = await handler(makeRequest(method), { params });

    // Past the gate the stubbed handlers end in a validation/404 response —
    // anything but the approval-required refusal.
    const body = await res.json().catch(() => ({}));
    expect(body.code).not.toBe('AGENT_APPROVAL_REQUIRED');
  });
});
