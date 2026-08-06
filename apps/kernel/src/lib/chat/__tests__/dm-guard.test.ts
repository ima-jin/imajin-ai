import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock DB ────────────────────────────────────────────────────────────────
// Three in-memory tables back every scenario: conversations_v2 (does a thread
// exist?), auth.identities (actor vs forest, human vs agent) and
// connections.connections (is the pair connected?).

type ConversationRow = { did: string };
type IdentityRow = { id: string; scope: string; subtype: string | null };
type ConnectionRow = { didA: string; didB: string; disconnectedAt: string | null };

const h = vi.hoisted(() => {
  const conversations: { did: string }[] = [];
  const identities: { id: string; scope: string; subtype: string | null }[] = [];
  const connections: { didA: string; didB: string; disconnectedAt: string | null }[] = [];

  const F = {
    conversationsV2: { did: 'did' },
    identities: { id: 'id', scope: 'scope', subtype: 'subtype' },
    connections: { didA: 'didA', didB: 'didB', disconnectedAt: 'disconnectedAt' },
  };

  type Pred = { op: string; col?: string; val?: unknown; preds?: Pred[] };
  const ops = {
    eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
    and: (...preds: unknown[]) => ({ op: 'and', preds }),
    isNull: (col: unknown) => ({ op: 'isNull', col }),
  };

  const match = (row: Record<string, unknown>, pred: Pred): boolean => {
    switch (pred.op) {
      case 'eq': return row[pred.col as string] === pred.val;
      case 'isNull': return row[pred.col as string] === null || row[pred.col as string] === undefined;
      case 'and': return (pred.preds ?? []).every((p) => match(row, p));
      default: return true;
    }
  };

  function finder<T extends object>(rows: T[], table: Record<string, string>) {
    return ({ where }: { where: unknown }) => {
      const pred = typeof where === 'function'
        ? (where as (t: unknown, o: unknown) => Pred)(table, ops)
        : (where as Pred);
      return Promise.resolve(rows.find((r) => match(r as Record<string, unknown>, pred)));
    };
  }

  const db = {
    query: {
      conversationsV2: { findFirst: finder(conversations, F.conversationsV2) },
      identities: { findFirst: finder(identities, F.identities) },
      connections: { findFirst: finder(connections, F.connections) },
    },
  };

  return { conversations, identities, connections, F, db, ops };
});

vi.mock('@/src/db', () => ({
  db: h.db,
  conversationsV2: h.F.conversationsV2,
  identities: h.F.identities,
}));

vi.mock('drizzle-orm', () => h.ops);

import { dmDid } from '../conversation-did';
import { resolveDmConversationTarget, canonicalDmConversationDid } from '../dm-guard';
import { DM_CONNECTION_REQUIRED } from '../connection-check';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ALICE = 'did:imajin:alice';
const BOB = 'did:imajin:bob';
const STRANGER = 'did:imajin:stranger';
const AGENT = 'did:imajin:agentbot';
const FOREST = 'did:imajin:forestcommunity';

function human(id: string): IdentityRow {
  return { id, scope: 'actor', subtype: 'human' };
}

function agent(id: string): IdentityRow {
  return { id, scope: 'actor', subtype: 'agent' };
}

function community(id: string): IdentityRow {
  return { id, scope: 'community', subtype: null };
}

function connect(a: string, b: string): ConnectionRow {
  const [didA, didB] = [a, b].sort((x, y) => x.localeCompare(y));
  return { didA, didB, disconnectedAt: null };
}

function seedConversation(did: string): ConversationRow {
  return { did };
}

beforeEach(() => {
  h.conversations.splice(0);
  h.identities.splice(0, h.identities.length, human(ALICE), human(BOB), human(STRANGER), agent(AGENT), community(FOREST));
  h.connections.splice(0, h.connections.length, connect(ALICE, BOB));
});

// ─── #1649 — DM thread uniqueness ───────────────────────────────────────────

describe('DM thread uniqueness (#1649)', () => {
  it('rewrites a raw person DID used as the conversation key to the canonical dmDid', async () => {
    const result = await resolveDmConversationTarget({ conversationDid: BOB, senderDid: ALICE });
    expect(result).toMatchObject({ ok: true, conversationDid: dmDid(ALICE, BOB), exists: false });
  });

  it('lands both directions of the same pair on one conversation DID', async () => {
    const fromAlice = await resolveDmConversationTarget({ conversationDid: BOB, senderDid: ALICE });
    const fromBob = await resolveDmConversationTarget({ conversationDid: ALICE, senderDid: BOB });

    expect(fromAlice.ok && fromBob.ok).toBe(true);
    const aliceDid = fromAlice.ok ? fromAlice.conversationDid : 'a';
    const bobDid = fromBob.ok ? fromBob.conversationDid : 'b';
    expect(aliceDid).toBe(bobDid);
    expect(aliceDid).toBe(dmDid(ALICE, BOB));
  });

  it('keeps a canonical dm DID untouched', async () => {
    const canonical = dmDid(ALICE, BOB);
    const result = await resolveDmConversationTarget({
      conversationDid: canonical,
      senderDid: ALICE,
      recipientDid: BOB,
    });
    expect(result).toMatchObject({ ok: true, conversationDid: canonical });
  });

  it('rewrites a non-canonical dm DID when the recipient is named', async () => {
    const result = await resolveDmConversationTarget({
      conversationDid: 'did:imajin:dm:deadbeefdeadbeef',
      senderDid: ALICE,
      recipientDid: BOB,
    });
    expect(result).toMatchObject({ ok: true, conversationDid: dmDid(ALICE, BOB) });
  });

  it('reuses the canonical thread when it already exists', async () => {
    const canonical = dmDid(ALICE, BOB);
    h.conversations.push(seedConversation(canonical));

    const result = await resolveDmConversationTarget({ conversationDid: BOB, senderDid: ALICE });
    expect(result).toMatchObject({ ok: true, conversationDid: canonical, exists: true });
  });

  it('leaves group, event and forest-identity conversation DIDs alone', async () => {
    const untouched = ['did:imajin:group:abc123', 'did:imajin:evt_launch', 'did:imajin:event:launch', FOREST];

    for (const did of untouched) {
      const result = await resolveDmConversationTarget({ conversationDid: did, senderDid: ALICE });
      expect(result).toMatchObject({ ok: true, conversationDid: did });
    }
  });

  it('canonicalDmConversationDid returns the canonical DID without gating', async () => {
    expect(await canonicalDmConversationDid(STRANGER, ALICE)).toBe(dmDid(ALICE, STRANGER));
    expect(await canonicalDmConversationDid('did:imajin:group:abc', ALICE)).toBe('did:imajin:group:abc');
  });
});

// ─── #855 — connection / consent gate ───────────────────────────────────────

describe('DM connection gate (#855)', () => {
  it('allows a new thread between connected parties', async () => {
    const result = await resolveDmConversationTarget({ conversationDid: BOB, senderDid: ALICE });
    expect(result.ok).toBe(true);
  });

  it('refuses a new thread with someone the sender is not connected to', async () => {
    const result = await resolveDmConversationTarget({ conversationDid: STRANGER, senderDid: ALICE });
    expect(result).toEqual({ ok: false, status: 403, error: DM_CONNECTION_REQUIRED });
  });

  it('refuses a new thread when the connection has been severed', async () => {
    h.connections.splice(0, h.connections.length, { ...connect(ALICE, BOB), disconnectedAt: '2026-01-01T00:00:00Z' });

    const result = await resolveDmConversationTarget({ conversationDid: BOB, senderDid: ALICE });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it('allows a new thread with an agent DID without any connection', async () => {
    const result = await resolveDmConversationTarget({ conversationDid: AGENT, senderDid: ALICE });
    expect(result).toMatchObject({ ok: true, conversationDid: dmDid(ALICE, AGENT) });
  });

  it('skips the gate when the thread already exists', async () => {
    const canonical = dmDid(ALICE, STRANGER);
    h.conversations.push(seedConversation(canonical));

    const result = await resolveDmConversationTarget({
      conversationDid: canonical,
      senderDid: ALICE,
      recipientDid: STRANGER,
    });
    expect(result).toMatchObject({ ok: true, conversationDid: canonical, exists: true });
  });

  it('skips the gate when a legacy thread keyed on the raw person DID already exists', async () => {
    h.conversations.push(seedConversation(STRANGER));

    const result = await resolveDmConversationTarget({ conversationDid: STRANGER, senderDid: ALICE });
    expect(result).toMatchObject({ ok: true, conversationDid: STRANGER, exists: true });
  });

  it('allows notes-to-self', async () => {
    const result = await resolveDmConversationTarget({ conversationDid: ALICE, senderDid: ALICE });
    expect(result.ok).toBe(true);
  });

  it('refuses when the recipient named alongside a dm hash is not connected', async () => {
    const result = await resolveDmConversationTarget({
      conversationDid: dmDid(ALICE, STRANGER),
      senderDid: ALICE,
      recipientDid: STRANGER,
    });
    expect(result).toMatchObject({ ok: false, status: 403, error: DM_CONNECTION_REQUIRED });
  });
});
