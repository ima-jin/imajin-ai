// @vitest-environment jsdom
/**
 * DocumentSigningCard — typescript:S9383 (#2568).
 *
 * The Sign / Decline click handlers now wrap their async work in
 * `fireAndForget(...)`. These tests pin that clicking still runs the same
 * sign / decline flows and updates the card exactly as before.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import DocumentSigningCard from '../DocumentSigningCard';
import type { DocumentAttestation, Signature } from '../DocumentSigningCard';

vi.mock('../SignerList', () => ({ default: () => null }));
vi.mock('../DocumentViewer', () => ({ default: () => null }));

const SESSION_DID = 'did:imajin:me';

const attestation: DocumentAttestation = {
  id: 'att_1',
  issuerDid: 'did:imajin:issuer',
  subjectDid: 'did:imajin:subject',
  type: 'document',
  payload: { title: 'Lease' },
  attestationStatus: 'collecting',
  documentHash: 'hash123',
  documentAssetId: null,
  totalSigners: 1,
  issuedAt: new Date('2026-08-01T00:00:00Z'),
  expiresAt: null,
};

const pendingSigs: Signature[] = [
  { id: 's1', signerDid: SESSION_DID, status: 'pending', role: 'signer', signedAt: null },
];
const signedSigs = [{ ...pendingSigs[0], status: 'signed' }];

function json(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('DocumentSigningCard fire-and-forget handlers', () => {
  it('Sign click runs the signing flow and updates status', async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.includes('/identity/')) return json({ signature: 'jws-token' });
      if (url.endsWith('/sign')) return json({ status: 'executed' });
      return json({ signatures: signedSigs });
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<DocumentSigningCard attestation={attestation} signatures={pendingSigs} sessionDid={SESSION_DID} />);
    fireEvent.click(screen.getByText('Sign'));

    await waitFor(() => expect(screen.getByText('executed')).toBeDefined());
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(screen.queryByText('Sign')).toBeNull();
  });

  it('Decline click runs the decline flow and updates status', async () => {
    vi.stubGlobal('confirm', vi.fn(() => true));
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith('/decline')) return json({});
      return json({ signatures: [{ ...pendingSigs[0], status: 'declined' }] });
    });
    vi.stubGlobal('fetch', fetchSpy);

    render(<DocumentSigningCard attestation={attestation} signatures={pendingSigs} sessionDid={SESSION_DID} />);
    fireEvent.click(screen.getByText('Decline'));

    await waitFor(() => expect(screen.getByText('declined')).toBeDefined());
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('Decline click does nothing when the user cancels the confirm dialog', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(<DocumentSigningCard attestation={attestation} signatures={pendingSigs} sessionDid={SESSION_DID} />);
    fireEvent.click(screen.getByText('Decline'));

    await Promise.resolve();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText('collecting')).toBeDefined();
  });
});
