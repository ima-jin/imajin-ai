// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DocumentSigningCard, { type DocumentAttestation, type Signature } from '../DocumentSigningCard';
import DocumentVerification from '../DocumentVerification';
import CreateDocumentForm from '../CreateDocumentForm';

const ORG = 'did:imajin:org';
const HUMAN = 'did:imajin:human';
const PARTY = 'did:imajin:party';
const document: DocumentAttestation = {
  id: 'att_agreement', issuerDid: ORG, subjectDid: PARTY, type: 'agreement',
  payload: { title: 'Service agreement' }, attestationStatus: 'collecting',
  documentHash: 'hash123', documentAssetId: 'asset_1', totalSigners: 2,
  issuedAt: new Date('2026-10-20T10:00:00Z'), expiresAt: null, revokedAt: null,
};
const signatures: Signature[] = [
  { id: 'org', signerDid: ORG, status: 'signed', role: 'author', signedAt: new Date('2026-10-20T10:00:00Z'),
    identity: { name: 'Example Studio', handle: 'studio', avatarUrl: null } },
  { id: 'party', signerDid: PARTY, status: 'pending', role: 'signer', signedAt: null },
];

vi.mock('../../../components/IdentityPicker', () => ({
  default: ({ onSelect }: { onSelect: (identity: unknown) => void }) => (
    <button onClick={() => onSelect({ did: PARTY, name: 'Counterparty', handle: 'party' })}>Choose counterparty</button>
  ),
}));

const json = (body: unknown, ok = true) => ({ ok, json: async () => body });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function card(account = PARTY, overrides: Partial<DocumentAttestation> = {}) {
  return render(<DocumentSigningCard attestation={{ ...document, ...overrides }} signatures={signatures}
    sessionDid={account} actingHumanDid={account === ORG ? HUMAN : PARTY} defaultExpanded />);
}

describe('agreement identity and signing', () => {
  it('counterparty sees title, organization name, document and their own signing account', () => {
    card();
    expect(screen.getByText('Service agreement')).toBeDefined();
    expect(screen.getAllByText('Example Studio').length).toBeGreaterThan(0);
    expect(screen.getByTitle('Service agreement').getAttribute('src')).toBe('/auth/api/documents/att_agreement/content');
    expect(screen.getByText('Signing account:').textContent).toContain(PARTY);
    expect(screen.getByText(/node-witnessed action/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sign', exact: true })).toBeDefined();
  });

  it('does not show signing controls after expiry even if status has not yet updated', () => {
    card(PARTY, { expiresAt: new Date('2000-01-01') });
    expect(screen.queryByRole('button', { name: 'Sign', exact: true })).toBeNull();
  });

  it('shows the recorded author human and distinguishes a DID-key signature model', () => {
    card(PARTY, { payload: { title: 'Service agreement', actingHumanDid: HUMAN,
      signedBy: { [ORG]: { actingHumanDid: HUMAN, signatureModel: 'did-key' } } } });
    expect(screen.getAllByText(HUMAN).length).toBeGreaterThan(0);
    expect(screen.getByText(/Recorded signature model: DID-key/)).toBeDefined();
    expect(screen.queryByText(/node-witnessed action/)).toBeNull();
  });

  it('signs as the counterparty, not the org or human controller, and parses refreshed dates', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ signature: 'witness' }))
      .mockResolvedValueOnce(json({ status: 'executed' }))
      .mockResolvedValueOnce(json({
        attestation: { ...document, attestationStatus: 'executed', revokedAt: null },
        signatures: signatures.map((sig) => ({ ...sig, status: 'signed', signedAt: '2026-10-20T12:00:00Z' })),
      }));
    vi.stubGlobal('fetch', fetch);
    card(PARTY, { type: 'document.created' });
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Sign', exact: true }));
    await waitFor(() => expect(screen.getByText('executed')).toBeDefined());
    expect(fetch.mock.calls[0][0]).toBe(`/auth/api/identity/${encodeURIComponent(PARTY)}/sign`);
    expect(JSON.parse(fetch.mock.calls[0][1].body).payload).toBe(JSON.stringify({ did: PARTY, document_hash: 'hash123' }));
    expect(fetch.mock.calls[1][1].credentials).toBe('include');
    expect(screen.queryByText('Sign', { exact: true })).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeDefined();
  });

  it.each([
    [{ error: 'Forbidden for auth' }, false, 'Forbidden for auth'],
    [{ signed: false, reason: 'no_chain' }, true, 'Unable to sign: no_chain'],
    [{}, true, 'Unable to sign document hash'],
  ])('fails closed when identity signing refuses or returns no signature', async (response, ok, error) => {
    const fetch = vi.fn().mockResolvedValue(json(response, ok));
    vi.stubGlobal('fetch', fetch);
    card();
    fireEvent.click(screen.getByRole('button', { name: 'Sign', exact: true }));
    await waitFor(() => expect(screen.getByText(error)).toBeDefined());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not show sign/revoke controls to an unrelated account', () => {
    card('did:imajin:stranger');
    expect(screen.queryByRole('button', { name: 'Sign', exact: true })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('does not send a signing request if the hash is missing', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    card(PARTY, { documentHash: null });
    fireEvent.click(screen.getByRole('button', { name: 'Sign', exact: true }));
    await waitFor(() => expect(screen.getByText('Document hash missing')).toBeDefined());
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('agreement party revocation', () => {
  it.each([ORG, PARTY])('allows party %s to revoke without deleting the card', async (account) => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const fetch = vi.fn().mockResolvedValue(json({ id: document.id, revokedAt: '2026-10-20T12:00:00Z' }));
    vi.stubGlobal('fetch', fetch);
    card(account);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.getByText('revoked', { exact: true })).toBeDefined());
    expect(fetch).toHaveBeenCalledWith('/auth/api/attestations/att_agreement/revoke', expect.objectContaining({ method: 'POST', credentials: 'include' }));
    expect(screen.getByText(/Agreement revoked/)).toBeDefined();
    expect(screen.getByText('Service agreement')).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Sign', exact: true })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('preserves revokedAt and disables signing on a previously revoked agreement', () => {
    card(PARTY, { revokedAt: new Date('2026-10-20T12:00:00Z') });
    expect(screen.getByText('revoked', { exact: true })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Sign', exact: true })).toBeNull();
  });

  it('does not revoke if confirmation is cancelled', () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    card();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows a refusal and retains the existing state', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'Access denied' }, false)));
    card();
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(screen.getByText('Access denied')).toBeDefined());
    expect(screen.getByText('collecting')).toBeDefined();
  });
});

describe('saved file verification', () => {
  it('does not submit without a file', () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<DocumentVerification documentId="att_agreement" />);
    expect((screen.getByRole('button', { name: 'Verify file' }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [{ valid: true, hashMatches: true, signaturesValid: true, revoked: false }, 'Verified: file matches'],
    [{ valid: false, hashMatches: false, signaturesValid: true, revoked: false }, 'It may have been changed or tampered'],
    [{ valid: false, hashMatches: true, signaturesValid: false, revoked: false }, 'Recorded signatures could not'],
    [{ valid: false, hashMatches: true, signaturesValid: true, revoked: true }, 'This agreement has been revoked'],
    [{ valid: true, hashMatches: false, signaturesValid: true, revoked: false }, 'Verification failed'],
  ])('shows plain verification results and sends multipart file', async (response, message) => {
    const fetch = vi.fn().mockResolvedValue(json(response));
    vi.stubGlobal('fetch', fetch);
    render(<DocumentVerification documentId="att_agreement" />);
    const file = new File(['file bytes'], 'agreement.txt');
    fireEvent.change(screen.getByLabelText('Verify a saved document'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify file' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain(message));
    expect(fetch.mock.calls[0][0]).toBe('/auth/api/documents/att_agreement/verify');
    expect(fetch.mock.calls[0][1].body.get('file')).toBe(file);
    expect(fetch.mock.calls[0][1].headers).toBeUndefined();
    fireEvent.change(screen.getByLabelText('Verify a saved document'), { target: { files: [] } });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each([
    [{ error: 'Access denied' }, false, 'Access denied'],
    [{ valid: true }, true, 'Invalid verification response'],
  ])('fails closed on failed/malformed responses', async (response, ok, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(response, ok)));
    render(<DocumentVerification documentId="att_agreement" />);
    fireEvent.change(screen.getByLabelText('Verify a saved document'), { target: { files: [new File(['x'], 'x.txt')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Verify file' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain(message));
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('organization creation', () => {
  function createForm() {
    render(<CreateDocumentForm sessionDid={ORG} authorName="Example Studio" actingHumanDid={HUMAN}
      actingHumanName="Human Controller" defaultOpen onCreated={vi.fn()} />);
  }
  async function uploadAndChoose() {
    const input = globalThis.document.querySelector('input[type="file"]')!;
    fireEvent.change(input, { target: { files: [new File(['bytes'], 'contract.txt')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload', exact: true }));
    await screen.findByLabelText('Title');
    fireEvent.click(screen.getByText('Choose counterparty'));
  }

  it('names the org as author and first signer and identifies the acting human', () => {
    createForm();
    expect(screen.getByText('Author and first signer')).toBeDefined();
    expect(screen.getByText('Example Studio')).toBeDefined();
    expect(screen.getByText('Human Controller')).toBeDefined();
    expect(screen.getByText(ORG)).toBeDefined();
    expect(screen.getByText(HUMAN)).toBeDefined();
  });

  it('creates under the org DID while sending the other party as signer', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ id: 'asset', hash: 'hash' }))
      .mockResolvedValueOnce(json({ signature: 'witness' })).mockResolvedValueOnce(json({}));
    vi.stubGlobal('fetch', fetch);
    createForm();
    await uploadAndChoose();
    fireEvent.click(screen.getByRole('button', { name: 'Create Signing Request' }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(fetch.mock.calls[1][0]).toBe(`/auth/api/identity/${encodeURIComponent(ORG)}/sign`);
    expect(JSON.parse(fetch.mock.calls[1][1].body).payload).toBe(JSON.stringify({ did: ORG, document_hash: 'hash' }));
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({ signers: [PARTY], author_jws: 'witness' });
  });

  it('never creates a document after auth-scoped act-as refusal', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(json({ id: 'asset', hash: 'hash' }))
      .mockResolvedValueOnce(json({ error: 'Forbidden for auth' }, false));
    vi.stubGlobal('fetch', fetch);
    createForm();
    await uploadAndChoose();
    fireEvent.click(screen.getByRole('button', { name: 'Create Signing Request' }));
    await screen.findByText('Forbidden for auth');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
