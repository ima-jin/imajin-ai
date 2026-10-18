import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { canonicalize } from '@imajin/auth';
import { readApprovalSessionOutcome } from '../operator-approval-session-outcome';

const store = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../jin/session-command-store', () => ({ getSessionEvent: store.get }));

const principal = 'did:imajin:principal';
const approvalId = 'native_1';
const command = {
  type: 'session.approve', commandId: 'command_1', principal, to: 'did:imajin:agent', issuer: 'did:imajin:kernel',
  issuedAt: '2026-10-17T17:00:00.000Z', expiresAt: '2026-10-17T17:05:00.000Z',
  payload: { loopId: 'loop_1', approvalId, kind: 'exec' },
  signature: { alg: 'ed25519', keyId: 'a'.repeat(64), sig: 'b'.repeat(128) },
  countersignature: { alg: 'ed25519', keyId: 'c'.repeat(64), sig: 'd'.repeat(128) },
};
function receipt(overrides: Record<string, unknown> = {}, commandType = command.type) {
  const payload = {
    eventType: `loop.${commandType}.completed`, commandId: command.commandId, command: commandType,
    outcome: 'completed', principal, issuer: command.issuer, agentDid: command.to,
    payloadHash: createHash('sha256').update(canonicalize(command.payload)).digest('hex'),
    at: '2026-10-17T17:01:00.000Z', approvalId, loopId: command.payload.loopId, ...overrides,
  };
  return {
    loop_id: command.payload.loopId, issuer: command.to, principal, type: payload.eventType,
    payload: { ...payload, attestation: { from: command.to, type: 'agent', timestamp: 1, payload, signature: 'e'.repeat(128) } },
  };
}

beforeEach(() => {
  store.get.mockReset().mockResolvedValue(receipt());
});

describe('native approval attestation projection', () => {
  it.each(['approve', 'reject'])('projects correlated %s resolution, not transport delivery', async (decision) => {
    const type = decision === 'approve' ? 'session.approve' : 'session.deny';
    store.get.mockResolvedValue(receipt({}, type));
    expect(await readApprovalSessionOutcome(principal, approvalId, decision, { ...command, type })).toEqual({
      commandId: command.commandId, outcome: 'completed', at: '2026-10-17T17:01:00.000Z',
    });
    expect(store.get).toHaveBeenCalledWith('result', command.commandId, principal);
  });

  it('projects signed failure with bounded reason', async () => {
    store.get.mockResolvedValue(receipt({ outcome: 'failed', eventType: 'loop.session.approve.failed', reason: 'approval_not_found' }));
    expect(await readApprovalSessionOutcome(principal, approvalId, 'approve', command)).toMatchObject({
      outcome: 'failed', reason: 'approval_not_found',
    });
  });

  it.each([undefined, {}, { ...command, principal: 'did:imajin:foreign' }, { ...command, payload: { ...command.payload, approvalId: 'foreign' } }])('refuses malformed or foreign stored command %j', async (raw) => {
    expect(await readApprovalSessionOutcome(principal, approvalId, 'approve', raw)).toBeNull();
    expect(store.get).not.toHaveBeenCalled();
  });

  it.each(['withdrawn', undefined, 'reject'])('refuses inconsistent stored decision %s', async (decision) => {
    expect(await readApprovalSessionOutcome(principal, approvalId, decision, command)).toBeNull();
  });

  it.each([
    { commandId: 'foreign' }, { command: 'session.deny' }, { principal: 'did:imajin:foreign' },
    { issuer: 'did:imajin:foreign' }, { agentDid: 'did:imajin:foreign' }, { approvalId: 'foreign' },
    { eventType: 'loop.session.deny.completed' }, { payloadHash: 'f'.repeat(64) }, { outcome: 'delivered' },
  ])('never projects an uncorrelated signed result %j', async (change) => {
    store.get.mockResolvedValue(receipt(change));
    expect(await readApprovalSessionOutcome(principal, approvalId, 'approve', command)).toBeNull();
  });

  it.each([
    null,
    { ...receipt(), issuer: 'did:imajin:foreign' },
    { ...receipt(), principal: 'did:imajin:foreign' },
    { ...receipt(), loop_id: 'foreign' },
    { ...receipt(), type: 'loop.command.transport' },
    { ...receipt(), payload: { delivered: true } },
    { ...receipt(), payload: { attestation: { ...receipt().payload.attestation, from: 'did:imajin:foreign' } } },
  ])('requires a result record from the authenticated issuer for this exact loop %j', async (record) => {
    store.get.mockResolvedValue(record);
    expect(await readApprovalSessionOutcome(principal, approvalId, 'approve', command)).toBeNull();
  });
});
