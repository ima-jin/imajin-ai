// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
const h = vi.hoisted(() => ({ actor: vi.fn(), redirect: vi.fn() }));
vi.mock('@/src/lib/auth/document-authorization', () => ({ requireDocumentActor: h.actor }));
vi.mock('@/src/lib/http/node-url', () => ({ nodeUrl: () => 'https://test.example' }));
vi.mock('next/headers', () => ({ headers: async () => new Headers({ cookie: 'test-session' }) }));
vi.mock('next/navigation', () => ({ redirect: h.redirect }));
vi.mock('../components/LegalEntityForm', () => ({ default: ({ did }: { did: string }) => <p>Owner form: {did}</p> }));
import LegalEntityPage from '../page';
beforeEach(() => {
  vi.resetAllMocks();
  h.redirect.mockImplementation(() => { throw new Error('redirect'); });
});
afterEach(cleanup);
describe('legal entity settings page authority', () => {
  it.each(['did:imajin:human', 'did:imajin:business'])('renders the owner form for %s', async did => {
    h.actor.mockResolvedValue({ effectiveDid: did, actingHumanDid: 'did:imajin:human' });
    render(await LegalEntityPage());
    expect(screen.getByText(`Owner form: ${did}`)).toBeDefined();
    expect(h.actor).toHaveBeenCalledWith(expect.any(Request), { write: true });
  });
  it('redirects unauthenticated owners to auth', async () => {
    h.actor.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(LegalEntityPage()).rejects.toThrow('redirect');
    expect(h.redirect).toHaveBeenCalledWith('/auth');
  });
  it('renders no legal form for a forged or disallowed act-as selection', async () => {
    h.actor.mockResolvedValue(new Response(null, { status: 403 }));
    render(await LegalEntityPage());
    expect(screen.getByRole('alert').textContent).toContain('active owner or admin');
    expect(screen.queryByText(/Owner form/)).toBeNull();
  });
});
