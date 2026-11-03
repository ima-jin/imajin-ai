import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  node: vi.fn(), prepare: vi.fn(), insert: vi.fn(), conflict: vi.fn(), transaction: vi.fn(),
}));
vi.mock('@/src/db', () => ({
  db: { transaction: mocks.transaction },
  attestations: 'attestations', systemEvents: 'events',
}));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeSelfInfo: mocks.node }));
vi.mock('@/src/lib/auth/emit-mechanical-attestation', () => ({ prepareMechanicalAttestation: mocks.prepare }));
import { recordLivenessEvent } from '../ops-liveness';
const event = {
  id: 'a25ce4aa-fcff-44a3-a3bb-d25e16e95034', app: 'prod-jin', port: 7000,
  outcome: 'restarted' as const, failures: 3, at: '2026-11-02T13:00:00.000Z',
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.node.mockResolvedValue({ did: 'did:imajin:node', nodeOperatorDid: 'did:imajin:operator' });
  mocks.prepare.mockImplementation(async (params, id) => ({ ...params, id, issuerDid: 'did:imajin:node' }));
  mocks.conflict.mockResolvedValue(undefined);
  mocks.insert.mockReturnValue({ values: (row: unknown) => ({ onConflictDoNothing: () => mocks.conflict(row) }) });
  mocks.transaction.mockImplementation(async operation => operation({ insert: mocks.insert }));
});
afterEach(() => vi.restoreAllMocks());
it('writes a node-signed mechanical receipt and idempotent Record projection in one transaction', async () => {
  await recordLivenessEvent(event);
  expect(mocks.prepare).toHaveBeenCalledWith(expect.objectContaining({
    type: 'ops.liveness.restart', subjectDid: 'did:imajin:operator',
    payload: { ...event, operatorDid: 'did:imajin:operator', issuerDid: 'did:imajin:node' },
  }), `att_ops_${event.id}`);
  expect(mocks.transaction).toHaveBeenCalledTimes(1);
  expect(mocks.conflict).toHaveBeenCalledTimes(2);
  expect(mocks.conflict).toHaveBeenLastCalledWith(expect.objectContaining({
    id: `ops_${event.id}`, did: 'did:imajin:node', service: 'ops', status: 'success',
    payload: expect.objectContaining({ operatorDid: 'did:imajin:operator', attestationId: `att_ops_${event.id}` }),
  }));
});
it('records a failed restart as failure', async () => {
  await recordLivenessEvent({ ...event, outcome: 'restart-failed' });
  expect(mocks.conflict).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'failure' }));
});
it.each([null, { did: 'did:imajin:node', nodeOperatorDid: null }])('fails closed without an authoritative node operator', async node => {
  mocks.node.mockResolvedValue(node);
  await expect(recordLivenessEvent(event)).rejects.toThrow('Node operator is not configured');
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it('does not write an unsigned event when signing fails', async () => {
  mocks.prepare.mockRejectedValue(new Error('signing unavailable'));
  await expect(recordLivenessEvent(event)).rejects.toThrow();
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it('propagates transaction failure for safe outbox redelivery', async () => {
  mocks.transaction.mockRejectedValue(new Error('database unavailable'));
  await expect(recordLivenessEvent(event)).rejects.toThrow();
});
