import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  values: vi.fn(), send: vi.fn(), chain: vi.fn(), node: vi.fn(), owner: vi.fn(), sender: vi.fn(),
}));
vi.mock('@/src/db', () => ({ db: { insert: () => ({ values: mocks.values }) }, attestations: {} }));
vi.mock('@imajin/email', () => ({ sendEmail: mocks.send }));
vi.mock('@/src/lib/auth/dfos', () => ({ createAttestationEntry: mocks.chain }));
vi.mock('@/src/lib/kernel/node-identity', () => ({ getNodeDid: mocks.node }));
vi.mock('../store', () => ({ resolveMailOwner: mocks.owner }));
vi.mock('../resolver', () => ({ resolveMailSenderContext: async (options: { ownerDid?: string }) => ({
  sender: await mocks.sender(), ownerDid: await mocks.owner(options.ownerDid),
}) }));
import { canonicalize, crypto, ATTESTATION_TYPES, MECHANICAL_ATTESTATION_TYPES } from '@imajin/auth';
import { sendKernelEmail } from '../send';
import type { PreparedMechanicalAttestation } from '@/src/lib/auth/emit-mechanical-attestation';

const options = { purpose: 'signin' as const, to: 'private@example.com', subject: 'Private subject', html: 'secret token', messageRef: 'mail_ref_123' };
const node = 'did:imajin:node';
const owner = 'did:imajin:owner';
const fixture = crypto.generateKeypair();
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv('AUTH_PRIVATE_KEY', fixture.privateKey);
  mocks.node.mockResolvedValue(node);
  mocks.owner.mockImplementation(async (did?: string) => did);
  mocks.sender.mockResolvedValue({ from: 'Signin <signin@imajin.ai>', source: 'default' });
  mocks.send.mockResolvedValue({ success: true, messageId: 'provider-id' });
  mocks.values.mockResolvedValue(undefined);
  mocks.chain.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());
describe('signed kernel email', () => {
  it('verifies the real persisted canonical crypto signature and redaction-safe payload', async () => {
    expect(await sendKernelEmail({ ...options, appDid: 'did:imajin:app', ownerDid: owner, from: 'attacker@evil.com' }))
      .toEqual({ success: true, messageId: 'provider-id' });
    const row = mocks.values.mock.calls[0][0] as PreparedMechanicalAttestation;
    expect(row).toMatchObject({ type: 'mail.sent', issuerDid: node, subjectDid: 'did:imajin:app', attestationStatus: null });
    expect(row.payload).toEqual({ purpose: 'signin', onBehalfOfDid: 'did:imajin:app', messageRef: options.messageRef, sentByNodeDid: node, from: 'Signin <signin@imajin.ai>' });
    const canonical = canonicalize({ subject_did: row.subjectDid, type: row.type, context_id: row.contextId,
      context_type: row.contextType, payload: row.payload, issued_at: row.issuedAt.getTime() });
    expect(crypto.verifySync(row.signature, canonical, fixture.publicKey)).toBe(true);
    expect(crypto.verifySync(row.signature, canonical + 'tampered', fixture.publicKey)).toBe(false);
    expect(row.cid).toBeTruthy();
    expect(JSON.stringify(row)).not.toContain(options.to);
    expect(JSON.stringify(row)).not.toContain(options.html);
    expect(JSON.stringify(row)).not.toContain(options.subject);
    expect(mocks.send).toHaveBeenCalledWith({ to: options.to, subject: options.subject, html: options.html, from: 'Signin <signin@imajin.ai>' });
    expect(mocks.chain).toHaveBeenCalledWith({ issuer_did: node, subject_did: row.subjectDid, type: 'mail.sent',
      context_id: row.contextId, context_type: 'mail', payload: row.payload, issued_at: row.issuedAt });
    expect(ATTESTATION_TYPES).toContain('mail.sent');
    expect(MECHANICAL_ATTESTATION_TYPES).toContain('mail.sent');
  });
  it('preserves optional text, unsubscribe and valid caller reply-to transport options', async () => {
    await sendKernelEmail({ ...options, text: 'Plain', unsubscribeUrl: 'https://example.com/unsubscribe', replyTo: 'raw@example.com' });
    expect(mocks.send.mock.calls[0][0]).toMatchObject({ text: 'Plain', unsubscribeUrl: 'https://example.com/unsubscribe' });
    expect(mocks.send.mock.calls[0][0].replyTo).toBe('raw@example.com');
  });
  it('uses owner as subject and emits resolved reply-to', async () => {
    mocks.sender.mockResolvedValue({ from: 'Owner <x@example.com>', replyTo: 'reply@example.com', source: 'owner' });
    await sendKernelEmail({ ...options, ownerDid: owner });
    expect(mocks.values.mock.calls[0][0].subjectDid).toBe(owner);
    expect(mocks.send.mock.calls[0][0].replyTo).toBe('reply@example.com');
  });
  it('prefers a valid caller reply-to over the configured sender reply-to', async () => {
    mocks.sender.mockResolvedValue({ from: 'Owner <x@example.com>', replyTo: 'configured@example.com', source: 'owner' });
    await sendKernelEmail({ ...options, replyTo: 'organizer@example.org' });
    expect(mocks.send).toHaveBeenCalledWith(expect.objectContaining({
      from: 'Owner <x@example.com>', replyTo: 'organizer@example.org',
    }));
  });
  it.each(['a@example.org\r\nBcc: victim', 'not-an-address', ''])('rejects invalid caller reply-to %s before sending', async replyTo => {
    expect(await sendKernelEmail({ ...options, replyTo })).toEqual({ success: false, error: 'mail_signing_or_sender_unavailable' });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.values).not.toHaveBeenCalled();
    expect(mocks.chain).not.toHaveBeenCalled();
  });
  it('defaults subject/on-behalf-of to node and generates an opaque ref', async () => {
    await sendKernelEmail({ ...options, messageRef: undefined });
    expect(mocks.values.mock.calls[0][0]).toMatchObject({ subjectDid: node, payload: { onBehalfOfDid: node, messageRef: expect.stringMatching(/^mail_/) } });
  });
  it.each(['address@example.com', 'https://secret/link', 'secret\nvalue', '', 'a'.repeat(129)])('rejects unsafe ref %s before delivery', async messageRef => {
    expect((await sendKernelEmail({ ...options, messageRef })).success).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('fails before delivery if signing key absent', async () => {
    vi.stubEnv('AUTH_PRIVATE_KEY', '');
    expect((await sendKernelEmail(options)).success).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('fails before delivery if node absent', async () => {
    mocks.node.mockResolvedValue('');
    expect((await sendKernelEmail(options)).success).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('fails before delivery on app owner mismatch', async () => {
    mocks.owner.mockRejectedValue(new Error('owner mismatch'));
    expect((await sendKernelEmail(options)).success).toBe(false);
    expect(mocks.send).not.toHaveBeenCalled();
  });
  it('does not persist a sent event when provider rejects delivery', async () => {
    mocks.send.mockResolvedValue({ success: false, error: 'unavailable' });
    expect(await sendKernelEmail(options)).toEqual({ success: false, error: 'unavailable' });
    expect(mocks.values).not.toHaveBeenCalled();
    expect(mocks.chain).not.toHaveBeenCalled();
  });
  it.each(['db', 'dfos'])('honestly reports %s audit failure after successful delivery', async failure => {
    if (failure === 'db') mocks.values.mockRejectedValue(new Error('db offline'));
    else mocks.chain.mockResolvedValue(false);
    expect(await sendKernelEmail(options)).toEqual({ success: false, messageId: 'provider-id', error: 'mail_audit_failed_after_delivery_do_not_retry' });
    expect(mocks.send).toHaveBeenCalledOnce();
  });
});
