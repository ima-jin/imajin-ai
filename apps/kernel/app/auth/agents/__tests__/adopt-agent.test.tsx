// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const h = vi.hoisted(() => ({ sign: vi.fn(), fetch: vi.fn(), reload: vi.fn() }));
vi.mock('@/src/lib/auth/browser-keys', () => ({ sign: h.sign }));
import AdoptAgent from '../adopt-agent';

const AGENT = 'did:imajin:orphan';
// Generated fixture bytes stay in memory; no real key material in the fixture.
let privateKey: string;
beforeEach(() => {
  vi.clearAllMocks();
  privateKey = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  h.sign.mockResolvedValue('signature-only');
  h.reload.mockResolvedValue(undefined);
  h.fetch.mockImplementation(async (_url: string, init: RequestInit) => Response.json(
    JSON.parse(init.body as string).action === 'challenge'
      ? { challengeId: 'adopt_1', challenge: 'server-issued-bound-challenge' } : { did: AGENT },
  ));
  vi.stubGlobal('fetch', h.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(fileContent = () => JSON.stringify({ did: AGENT, privateKey })) {
  render(<AdoptAgent orgDid="did:imajin:artifact" onAdopted={h.reload} />);
  fireEvent.change(screen.getByLabelText('Orphan agent DID'), { target: { value: AGENT } });
  fireEvent.change(screen.getByLabelText('Adoption capabilities'), { target: { value: 'messages:write, intros:propose' } });
  const file = new File([], 'keypair.json', { type: 'application/json' });
  Object.defineProperty(file, 'text', { value: async () => fileContent() });
  fireEvent.change(screen.getByLabelText('Original agent keypair JSON (local only)'), { target: { files: [file] } });
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Sign proof & adopt agent' }));

describe('Adopt orphaned agent control', () => {
  it('signs locally and sends only challenge id/signature to adopt into the displayed org', async () => {
    setup();
    submit();
    await waitFor(() => expect(h.reload).toHaveBeenCalledOnce());
    expect(h.sign).toHaveBeenCalledWith('server-issued-bound-challenge', privateKey);
    expect(screen.getByText('Agent adopted. DID and keypair unchanged.')).toBeDefined();
    expect(h.fetch).toHaveBeenCalledWith('/auth/api/agents/adopt', expect.objectContaining({
      credentials: 'include', body: JSON.stringify({ action: 'adopt', challengeId: 'adopt_1', signature: 'signature-only' }),
    }));
    expect(JSON.stringify(h.fetch.mock.calls)).not.toContain(privateKey);
  });
  it('is disabled without a key file', () => {
    render(<AdoptAgent orgDid="did:imajin:artifact" onAdopted={h.reload} />);
    expect(screen.getByRole('button', { name: 'Sign proof & adopt agent' })).toHaveProperty('disabled', true);
  });
  it.each(['invalid-json', 'wrong-did', 'wrong-key-shape'])('rejects %s locally without sending a request', async kind => {
    setup(() => kind === 'invalid-json' ? '{' : JSON.stringify({ did: kind === 'wrong-did' ? 'did:imajin:other' : AGENT, privateKey: kind === 'wrong-key-shape' ? 'invalid' : privateKey }));
    submit();
    await screen.findByText('Choose the original keypair JSON for this agent DID');
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it.each(['challenge', 'adopt'])('surfaces %s refusal without reporting success', async action => {
    setup();
    h.fetch.mockImplementation(async (_url: string, init: RequestInit) => {
      if (JSON.parse(init.body as string).action === action) return Response.json({ error: 'Not an orphan' }, { status: 409 });
      return Response.json({ challengeId: 'adopt_1', challenge: 'server-issued-bound-challenge' });
    });
    submit();
    await screen.findByText('Not an orphan');
    expect(h.reload).not.toHaveBeenCalled();
  });
  it('uses a safe fallback when the server gives no error text', async () => {
    setup();
    h.fetch.mockResolvedValue(Response.json({}, { status: 500 }));
    submit();
    await screen.findByText('Adoption failed');
  });
  it('handles network failures', async () => {
    setup();
    h.fetch.mockRejectedValue(new Error('Network unavailable'));
    submit();
    await screen.findByText('Network unavailable');
  });
  it('handles signing failure without making an adopt request', async () => {
    setup();
    h.sign.mockRejectedValue(new Error('Signing unavailable'));
    submit();
    await screen.findByText('Signing unavailable');
    expect(h.fetch).toHaveBeenCalledTimes(1);
  });
});
