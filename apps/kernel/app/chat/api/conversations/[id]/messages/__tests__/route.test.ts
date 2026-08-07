/**
 * Tests for POST /chat/api/conversations/:id/messages (#1649).
 *
 * This route is a thin adapter over sendConversationMessage, which owns the DM
 * guard. The thing worth pinning is the plumbing: `recipientDid` must reach the
 * query layer, because that is what lets the guard resolve the canonical thread
 * instead of opening a duplicate.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const h = vi.hoisted(() => ({
  resolveEffectiveDid: vi.fn(),
  requireAuth: vi.fn(),
  lookupIdentity: vi.fn(),
  sendConversationMessage: vi.fn(),
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: h.requireAuth,
  resolveEffectiveDid: h.resolveEffectiveDid,
}));

vi.mock('@/src/lib/kernel/lookup', () => ({ lookupIdentity: h.lookupIdentity }));

vi.mock('@/src/lib/chat/queries', () => ({
  readConversationMessages: vi.fn(),
  sendConversationMessage: h.sendConversationMessage,
}));

import { POST } from '../route';

const ALICE = 'did:imajin:alice';
const BOB = 'did:imajin:bob';
const JIN = 'did:imajin:jin';

function post(body: unknown, id = encodeURIComponent(BOB)) {
  return POST({ json: () => Promise.resolve(body) } as unknown as NextRequest, {
    params: Promise.resolve({ id }),
  });
}

beforeEach(() => {
  h.resolveEffectiveDid.mockReset();
  h.requireAuth.mockReset();
  h.lookupIdentity.mockReset();
  h.sendConversationMessage.mockReset();

  h.resolveEffectiveDid.mockResolvedValue({ ok: true, effectiveDid: ALICE, via: 'session', composedBy: null });
  h.requireAuth.mockResolvedValue({ identity: { id: ALICE, tier: 'established', handle: 'alice' } });
  h.sendConversationMessage.mockResolvedValue({ ok: true, message: { id: 'msg_1' } });
});

describe('POST /chat/api/conversations/:id/messages', () => {
  it('forwards recipientDid so the guard can resolve the canonical thread', async () => {
    const res = await post({ content: { type: 'text', text: 'hi' }, recipientDid: BOB });

    expect(res.status).toBe(201);
    expect(h.sendConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        senderDid: ALICE,
        conversationDid: BOB,
        recipientDid: BOB,
      }),
    );
  });

  it('decodes the URL-encoded conversation DID before handing it on', async () => {
    await post({ content: { type: 'text', text: 'hi' } }, encodeURIComponent('did:imajin:dm:abc'));

    expect(h.sendConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({ conversationDid: 'did:imajin:dm:abc' }),
    );
  });

  it('propagates a plain refusal from the query layer', async () => {
    h.sendConversationMessage.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'You must be connected to message this person',
    });

    const res = await post({ content: { type: 'text', text: 'hi' } });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'You must be connected to message this person',
    });
  });

  it('preserves the structured capability-denied shape', async () => {
    h.sendConversationMessage.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'insufficient_scope',
      code: 'insufficient_scope',
      required: ['messages:write'],
    });

    const res = await post({ content: { type: 'text', text: 'hi' } });

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({
      error: 'insufficient_scope',
      code: 'insufficient_scope',
      required: ['messages:write'],
    });
  });

  it('forwards the composing agent so the write can record it (#1673)', async () => {
    h.resolveEffectiveDid.mockResolvedValue({
      ok: true,
      effectiveDid: ALICE,
      via: 'session',
      composedBy: JIN,
    });

    await post({ content: { type: 'text', text: 'hi' } });

    expect(h.sendConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({ senderDid: ALICE, composedBy: JIN }),
    );
  });

  it('forwards a null composer for a direct message (#1673)', async () => {
    await post({ content: { type: 'text', text: 'hi' } });

    expect(h.sendConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({ composedBy: null }),
    );
  });

  it('hydrates the sender from the identity lookup on the app path', async () => {
    h.resolveEffectiveDid.mockResolvedValue({ ok: true, effectiveDid: ALICE, via: 'app', composedBy: null });
    h.lookupIdentity.mockResolvedValue({ tier: 'verified', handle: 'alice' });

    await post({ content: { type: 'text', text: 'hi' } });

    expect(h.requireAuth).not.toHaveBeenCalled();
    expect(h.sendConversationMessage).toHaveBeenCalledWith(
      expect.objectContaining({ senderTier: 'verified', senderHandle: 'alice' }),
    );
  });

  it('propagates an auth failure without sending', async () => {
    h.resolveEffectiveDid.mockResolvedValue({ ok: false, error: 'Unauthorized', status: 401 });

    const res = await post({ content: { type: 'text', text: 'hi' } });

    expect(res.status).toBe(401);
    expect(h.sendConversationMessage).not.toHaveBeenCalled();
  });

  it('answers 500 when the body is not JSON', async () => {
    const res = await POST(
      { json: () => Promise.reject(new Error('bad json')) } as unknown as NextRequest,
      { params: Promise.resolve({ id: encodeURIComponent(BOB) }) },
    );

    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Failed to send message' });
  });
});
