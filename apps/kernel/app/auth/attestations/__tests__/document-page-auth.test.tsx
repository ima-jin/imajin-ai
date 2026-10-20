import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
const h = vi.hoisted(() => ({
  actor: vi.fn(), canRead: vi.fn(), select: vi.fn(), headers: vi.fn(),
}));
vi.mock('next/headers', () => ({ headers: h.headers }));
vi.mock('next/navigation', () => ({ redirect: () => { throw new Error('REDIRECT'); } }));
vi.mock('@/src/lib/http/node-url', () => ({ nodeUrl: () => 'https://node.example' }));
vi.mock('@/src/lib/auth/document-authorization', () => ({ requireDocumentActor: h.actor, canReadDocument: h.canRead }));
vi.mock('@/src/db', () => ({
  db: { select: h.select }, identities: {}, attestations: {}, attestationSignatures: {},
}));
vi.mock('../../components/AttestationList', () => ({ default: () => null }));
vi.mock('../components/CreateDocumentForm', () => ({ default: () => null }));
vi.mock('../components/DocumentList', () => ({ default: () => null }));
vi.mock('../components/DocumentSigningCard', () => ({ default: () => null }));
import AttestationsPage from '../page';
import DocumentDetailPage from '../../documents/[id]/page';
import { getDocumentPageActor } from '../../lib/get-document-page-actor';

beforeEach(() => {
  vi.resetAllMocks();
  h.headers.mockResolvedValue(new Headers({
    cookie: 'session=verified-personal-session; x-acting-as=did:imajin:other-org',
  }));
  h.actor.mockResolvedValue(new Response(null, { status: 403 }));
});
describe('server-rendered document authority', () => {
  it.each([401, 403])('does not trust an act-as cookie after refusal %s', async (status) => {
    h.actor.mockResolvedValue(new Response(null, { status }));
    expect(await getDocumentPageActor()).toBeNull();
    const [request] = h.actor.mock.calls[0];
    expect(request.headers.get('cookie')).toContain('x-acting-as=did:imajin:other-org');
    expect(h.select).not.toHaveBeenCalled();
  });
  it('does not read org attestations on forged act-as selection', async () => {
    await expect(AttestationsPage({ searchParams: Promise.resolve({}) })).rejects.toThrow('REDIRECT');
    expect(h.select).not.toHaveBeenCalled();
  });
  it('does not read a document on forged act-as selection', async () => {
    await expect(DocumentDetailPage({ params: Promise.resolve({ id: 'private' }) })).rejects.toThrow('REDIRECT');
    expect(h.select).not.toHaveBeenCalled();
    expect(h.canRead).not.toHaveBeenCalled();
  });
  it('preserves the validated org and actual human without taking identity from the cookie', async () => {
    const actor = { effectiveDid: 'did:imajin:authorized-org', actingHumanDid: 'did:imajin:owner' };
    h.actor.mockResolvedValue(actor);
    expect(await getDocumentPageActor()).toEqual(actor);
  });
  it('denies private document details to a valid but unrelated personal account', async () => {
    h.actor.mockResolvedValue({ effectiveDid: 'did:imajin:outsider', actingHumanDid: 'did:imajin:outsider' });
    h.canRead.mockResolvedValue(false);
    h.select.mockReturnValue({ from: () => ({ where: () => ({ limit: async () => [{
      id: 'private', issuerDid: 'did:imajin:org', type: 'agreement',
    }] }) }) });
    const result = renderToStaticMarkup(await DocumentDetailPage({ params: Promise.resolve({ id: 'private' }) }));
    expect(result).toContain('Document not found or access denied.');
    expect(h.select).toHaveBeenCalledTimes(1);
  });
});
