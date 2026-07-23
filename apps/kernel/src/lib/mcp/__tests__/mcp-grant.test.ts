import { describe, it, expect, vi } from 'vitest';

// ─── Mock channel_links DB ──────────────────────────────────────────────────
// Stub only the tables and helpers that mcp-grant.ts touches. The in-memory
// rows array drives every test scenario without touching a real DB.

type Row = { channel: string; did: string; appDid: string; status: string; scopes: string[] };

const h = vi.hoisted(() => {
  const rows: Row[] = [];
  const F = {
    channelLinks: { channel: 'channel', did: 'did', appDid: 'appDid', status: 'status', scopes: 'scopes' },
  };

  type Pred = { op: string; col?: string; val?: unknown; preds?: Pred[] };
  const match = (row: Row, pred: Pred): boolean => {
    switch (pred.op) {
      case 'eq':  return (row as Record<string, unknown>)[pred.col as string] === pred.val;
      case 'and': return (pred.preds ?? []).every((p) => match(row, p));
      default:    return true;
    }
  };

  const db = {
    select: (_proj?: unknown) => ({
      from: (_table: unknown) => ({
        where: (pred: Pred) =>
          Promise.resolve(rows.filter((r) => match(r, pred)).map((r) => ({ scopes: r.scopes }))),
      }),
    }),
  };

  return { rows, F, db };
});

vi.mock('@/src/db', () => ({ db: h.db, channelLinks: h.F.channelLinks }));
vi.mock('drizzle-orm', () => ({
  eq:  (col: unknown, val: unknown) => ({ op: 'eq',  col, val }),
  and: (...preds: unknown[])        => ({ op: 'and', preds }),
}));
vi.mock('../oauth-config', () => ({
  MCP_CONNECTOR_DID: 'did:imajin:mcp-connector',
  MCP_CHANNEL: 'mcp',
  getMcpIssuer: () => 'https://mcp.imajin.ai',
}));

import { resolveActiveMcpGrant, requireMcpGrant } from '../mcp-grant';

const OWNER = 'did:imajin:owner';
const MCP_DID = 'did:imajin:mcp-connector';
const CHANNEL = 'mcp';

function activeRow(scopes: string[]): Row {
  return { channel: CHANNEL, did: OWNER, appDid: MCP_DID, status: 'active', scopes };
}

function revokedRow(scopes: string[]): Row {
  return { channel: CHANNEL, did: OWNER, appDid: MCP_DID, status: 'revoked', scopes };
}

describe('resolveActiveMcpGrant', () => {
  it('returns true when an active row holds the requested scope', async () => {
    h.rows.splice(0, h.rows.length, activeRow(['media:read', 'media:write']));
    expect(await resolveActiveMcpGrant(OWNER, 'media:read')).toBe(true);
    expect(await resolveActiveMcpGrant(OWNER, 'media:write')).toBe(true);
  });

  it('returns false when no row exists', async () => {
    h.rows.splice(0);
    expect(await resolveActiveMcpGrant(OWNER, 'media:read')).toBe(false);
  });

  it('returns false when the row is revoked', async () => {
    h.rows.splice(0, h.rows.length, revokedRow(['media:read']));
    expect(await resolveActiveMcpGrant(OWNER, 'media:read')).toBe(false);
  });

  it('returns false when the active row does not include the requested scope', async () => {
    h.rows.splice(0, h.rows.length, activeRow(['media:read']));
    expect(await resolveActiveMcpGrant(OWNER, 'media:write')).toBe(false);
  });

  it('is isolated by DID — a different DID gets no grant', async () => {
    h.rows.splice(0, h.rows.length, activeRow(['media:read']));
    expect(await resolveActiveMcpGrant('did:imajin:other', 'media:read')).toBe(false);
  });
});

describe('requireMcpGrant', () => {
  it('resolves without throwing when an active grant exists', async () => {
    h.rows.splice(0, h.rows.length, activeRow(['connections:read']));
    await expect(requireMcpGrant(OWNER, 'connections:read')).resolves.toBeUndefined();
  });

  it('throws mcp_no_grant when no active grant exists', async () => {
    h.rows.splice(0);
    await expect(requireMcpGrant(OWNER, 'media:write')).rejects.toThrow('mcp_no_grant');
  });

  it('error message names the missing scope and includes a deep-link URL', async () => {
    h.rows.splice(0);
    await expect(requireMcpGrant(OWNER, 'media:share')).rejects.toThrow('media:share');
    await expect(requireMcpGrant(OWNER, 'media:share')).rejects.toThrow('/auth/connectors');
    await expect(requireMcpGrant(OWNER, 'media:share')).rejects.toThrow('connector=mcp');
  });

  it('throws when the only row is revoked', async () => {
    h.rows.splice(0, h.rows.length, revokedRow(['media:read']));
    await expect(requireMcpGrant(OWNER, 'media:read')).rejects.toThrow('mcp_no_grant');
  });
});
