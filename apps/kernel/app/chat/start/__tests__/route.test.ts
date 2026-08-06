import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { NextRequest } from 'next/server';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => ({
  conversations: [] as { did: string }[],
  inserted: [] as Record<string, unknown>[],
  canInitiateDm: vi.fn(),
}));

vi.mock('@imajin/auth', () => ({
  requireAuth: vi.fn().mockResolvedValue({ identity: { id: 'did:imajin:alice' } }),
  resolveActingDid: (identity: { id: string }) => identity.id,
}));

vi.mock('@imajin/config', () => ({
  buildPublicUrl: () => 'https://chat.example',
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ col, val }),
}));

vi.mock('@/src/db', () => ({
  db: {
    query: {
      conversationsV2: {
        findFirst: ({ where }: { where: { val: string } }) =>
          Promise.resolve(h.conversations.find((c) => c.did === where.val)),
      },
    },
    insert: (table: { name: string }) => ({
      values: (row: Record<string, unknown>) => ({
        onConflictDoNothing: () => {
          h.inserted.push({ table: table.name, ...row });
          return Promise.resolve();
        },
      }),
    }),
  },
  conversationsV2: { name: 'conversations_v2', did: 'did' },
  conversationMembers: { name: 'conversation_members' },
}));

vi.mock('@/src/lib/chat/connection-check', () => ({
  canInitiateDm: h.canInitiateDm,
  DM_CONNECTION_REQUIRED: 'You must be connected to message this person',
}));

import { GET } from '../route';
import { dmDid } from '@/src/lib/chat/conversation-did';

const ALICE = 'did:imajin:alice';
const BOB = 'did:imajin:bob';

function startRequest(targetDid: string): NextRequest {
  return {
    nextUrl: new URL(`https://chat.example/start?did=${encodeURIComponent(targetDid)}`),
  } as unknown as NextRequest;
}

beforeEach(() => {
  h.conversations.splice(0);
  h.inserted.splice(0);
  h.canInitiateDm.mockReset();
});

describe('GET /start — DM connection gate (#855)', () => {
  it('refuses with 403 when the pair is not connected', async () => {
    h.canInitiateDm.mockResolvedValue(false);

    const res = await GET(startRequest(BOB));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: 'You must be connected to message this person' });
    expect(h.inserted).toHaveLength(0);
  });

  it('creates the conversation and both members when connected', async () => {
    h.canInitiateDm.mockResolvedValue(true);

    const res = await GET(startRequest(BOB));

    expect(h.canInitiateDm).toHaveBeenCalledWith(ALICE, BOB);
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain(dmDid(ALICE, BOB).slice('did:imajin:'.length).replace(':', '/'));
    expect(h.inserted.filter((r) => r.table === 'conversation_members')).toHaveLength(2);
  });

  it('skips the gate when the conversation already exists', async () => {
    h.conversations.push({ did: dmDid(ALICE, BOB) });

    const res = await GET(startRequest(BOB));

    expect(h.canInitiateDm).not.toHaveBeenCalled();
    expect(res.status).toBe(307);
  });
});
