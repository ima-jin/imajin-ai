import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  values: vi.fn(), send: vi.fn(), chain: vi.fn(), ready: vi.fn(), list: vi.fn(), owner: vi.fn(),
}));
vi.mock('@/src/db', () => ({ db: { insert: () => ({ values: mocks.values }) }, attestations: {} }));
vi.mock('@imajin/email', () => ({ sendEmail: mocks.send }));
vi.mock('@/src/lib/auth/dfos', () => ({ createAttestationEntry: mocks.chain }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: async () => 'did:imajin:node' }));
vi.mock('../readiness', () => ({ isDomainMailReady: mocks.ready }));
vi.mock('../store', () => ({ listSenderConfigs: mocks.list, resolveMailOwner: mocks.owner }));
import { canonicalize, crypto } from '@imajin/auth';
import { sendKernelEmail } from '../send';
import type { PreparedMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';
import type { MailPurpose, SenderConfig } from '../types';

const ownerDid = 'did:imajin:gbscontracting';
const nodeDid = 'did:imajin:node';
const fixture = crypto.generateKeypair();
const signin: SenderConfig = {
  ownerDid, appDid: '', purpose: 'signin', domain: 'gbscontracting.com',
  localPart: 'signin', displayName: 'GBS Contracting', replyTo: null,
};
const contact: SenderConfig = { ...signin, purpose: 'contact', localPart: 'info' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('AUTH_PRIVATE_KEY', fixture.privateKey);
  mocks.owner.mockImplementation(async (owner?: string) => owner);
  mocks.list.mockResolvedValue([signin, contact]);
  mocks.ready.mockResolvedValue(false);
  mocks.send.mockResolvedValue({ success: true, messageId: 'provider-id' });
  mocks.values.mockResolvedValue(undefined);
  mocks.chain.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());

function verifySignedSend(index: number, purpose: MailPurpose, from: string): void {
  const row = mocks.values.mock.calls[index][0] as PreparedMechanicalAttestation;
  expect(row).toMatchObject({ type: 'mail.sent', issuerDid: nodeDid, subjectDid: ownerDid, attestationStatus: null });
  expect(row.payload).toEqual({
    purpose, onBehalfOfDid: ownerDid, messageRef: `acceptance_${purpose}`,
    sentByNodeDid: nodeDid, from,
  });
  expect(mocks.send.mock.calls[index][0].from).toBe(from);
  expect(crypto.verifySync(row.signature, canonicalize({
    subject_did: row.subjectDid, type: row.type, context_id: row.contextId,
    context_type: row.contextType, payload: row.payload, issued_at: row.issuedAt.getTime(),
  }), fixture.publicKey)).toBe(true);
  expect(mocks.chain.mock.calls[index][0]).toMatchObject({
    issuer_did: nodeDid, subject_did: ownerDid, type: 'mail.sent', payload: row.payload,
  });
}

describe('real sender resolution and signed delivery acceptance', () => {
  it.each([
    ['signin', 'Signin <signin@imajin.ai>', 'GBS Contracting <signin@gbscontracting.com>'],
    ['contact', 'Imajin <info@imajin.ai>', 'GBS Contracting <info@gbscontracting.com>'],
  ] as const)('signs the actual %s sender before and after mail readiness changes', async (purpose, fallback, configured) => {
    const options = {
      purpose, ownerDid, to: 'recipient@example.com', subject: 'Private subject',
      html: 'Private body', messageRef: `acceptance_${purpose}`,
    };
    expect(await sendKernelEmail(options)).toEqual({ success: true, messageId: 'provider-id' });
    verifySignedSend(0, purpose, fallback);
    mocks.ready.mockResolvedValue(true);
    expect(await sendKernelEmail(options)).toEqual({ success: true, messageId: 'provider-id' });
    verifySignedSend(1, purpose, configured);
    expect(mocks.ready).toHaveBeenCalledWith(ownerDid, 'gbscontracting.com');
    expect(mocks.list).toHaveBeenNthCalledWith(1, ownerDid);
    expect(mocks.list).toHaveBeenNthCalledWith(2, ownerDid);
  });

  it('keeps receipts on the receipt purpose default even when other owner purposes are ready', async () => {
    mocks.ready.mockResolvedValue(true);
    expect(await sendKernelEmail({
      purpose: 'receipts', ownerDid, to: 'recipient@example.com', subject: 'Receipt',
      html: 'Private receipt', messageRef: 'acceptance_receipts',
    })).toEqual({ success: true, messageId: 'provider-id' });
    verifySignedSend(0, 'receipts', 'Receipts <receipts@imajin.ai>');
    expect(mocks.ready).not.toHaveBeenCalled();
  });
});
