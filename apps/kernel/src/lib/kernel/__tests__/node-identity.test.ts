import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { sqlMock } = vi.hoisted(() => ({
  sqlMock: vi.fn(),
}));

vi.mock('@imajin/db', () => ({
  getClient: () => sqlMock,
}));

vi.mock('@imajin/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
}));

describe('node-identity', () => {
  beforeEach(() => {
    vi.resetModules();
    sqlMock.mockReset();
    delete process.env.RELAY_DID;
  });

  it('getNodeDid() returns relay.relay_config.imajin_did when present', async () => {
    sqlMock.mockResolvedValueOnce([
      { imajin_did: 'did:imajin:jin', node_operator_did: null, node_fee_bps: 50, buyer_credit_bps: 25 },
    ]);
    const { getNodeDid } = await import('../node-identity');
    expect(await getNodeDid()).toBe('did:imajin:jin');
  });

  it('getNodeDid() falls back to RELAY_DID when the row is missing', async () => {
    process.env.RELAY_DID = 'did:imajin:fallback';
    sqlMock.mockResolvedValueOnce([]);
    const { getNodeDid } = await import('../node-identity');
    expect(await getNodeDid()).toBe('did:imajin:fallback');
  });

  it('getNodeDid() returns empty string when both the row and RELAY_DID are missing', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const { getNodeDid } = await import('../node-identity');
    expect(await getNodeDid()).toBe('');
  });

  it('getNodeDid() falls back to RELAY_DID when the query throws', async () => {
    process.env.RELAY_DID = 'did:imajin:fallback';
    sqlMock.mockRejectedValueOnce(new Error('connection refused'));
    const { getNodeDid } = await import('../node-identity');
    expect(await getNodeDid()).toBe('did:imajin:fallback');
  });

  it('resolveNodeDid() reports which source the DID came from (#2081)', async () => {
    sqlMock.mockResolvedValueOnce([{ imajin_did: 'did:imajin:jin' }]);
    const fromRow = await import('../node-identity');
    expect(await fromRow.resolveNodeDid()).toEqual({ did: 'did:imajin:jin', source: 'relay_config' });

    vi.resetModules();
    process.env.RELAY_DID = 'did:imajin:relay';
    sqlMock.mockResolvedValueOnce([]);
    const fromEnv = await import('../node-identity');
    expect(await fromEnv.resolveNodeDid()).toEqual({ did: 'did:imajin:relay', source: 'RELAY_DID' });

    vi.resetModules();
    delete process.env.RELAY_DID;
    sqlMock.mockResolvedValueOnce([]);
    const neither = await import('../node-identity');
    expect(await neither.resolveNodeDid()).toEqual({ did: '', source: 'none' });
  });

  it('caches the relay_config row — only queries the DB once per process', async () => {
    sqlMock.mockResolvedValueOnce([
      { imajin_did: 'did:imajin:jin', node_operator_did: null, node_fee_bps: 50, buyer_credit_bps: 25 },
    ]);
    const { getNodeDid, getNodeSelfInfo } = await import('../node-identity');
    await getNodeDid();
    await getNodeSelfInfo();
    await getNodeDid();
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('getNodeSelfInfo() returns did + public fee config when configured', async () => {
    sqlMock.mockResolvedValueOnce([
      { imajin_did: 'did:imajin:jin', node_operator_did: 'did:imajin:operator', node_fee_bps: 50, buyer_credit_bps: 25 },
    ]);
    const { getNodeSelfInfo } = await import('../node-identity');
    expect(await getNodeSelfInfo()).toEqual({
      did: 'did:imajin:jin',
      nodeOperatorDid: 'did:imajin:operator',
      nodeFeeBps: 50,
      buyerCreditBps: 25,
    });
  });

  it('getNodeSelfInfo() returns null when the node DID cannot be resolved', async () => {
    sqlMock.mockResolvedValueOnce([]);
    const { getNodeSelfInfo } = await import('../node-identity');
    expect(await getNodeSelfInfo()).toBeNull();
  });
});
