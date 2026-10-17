// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { canonicalize, crypto as authCrypto } from '@imajin/auth';
import type { ReachEnvelope } from '@/src/db/schemas/reach';
import { reachReplyEvent, type SignedReachReplyEvent } from '@/src/lib/auth/reach-reply-wire';
import { ReachInboxPanel } from '../reach-inbox-panel';
import type { ReachBearerKnock } from '@/src/lib/access/reach-bearer-wire';

const pair = {
  privateKey: '13'.repeat(32),
  publicKey: authCrypto.getPublicKey('13'.repeat(32)),
};

function envelope(): ReachEnvelope {
  return {
    reachId: 'reach_1', principalDid: 'did:imajin:principal', requesterDid: 'did:imajin:agent',
    onBehalfOfStubDid: 'did:imajin:stub',
    onBehalfOf: { platform: 'foreign', externalRef: 'external-1', selfDescription: '<b>Claim</b>' },
    claimVerified: false, topic: 'Research', message: '<img src=x onerror=alert(1)> **hello**',
    replyHandle: 'status', transcriptHash: 'a'.repeat(64), requesterSignature: 'sig', requesterTier: 'verified',
    grantId: 'grant_1', issuedAt: '2026-10-17T00:00:00.000Z', requestIssuedAt: '2026-10-17T00:00:00.000Z',
    signedEvent: {},
  };
}

function signedReply(message = 'Thank you'): SignedReachReplyEvent {
  const event = reachReplyEvent(envelope(), message, '2026-10-17T01:00:00.000Z');
  return { ...event, payload: { ...event.payload, signature: { keyId: pair.publicKey, alg: 'ed25519', sig: 'b'.repeat(128) } } };
}

function json(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as Response;
}

function installFetch(envelopes: unknown[] = [envelope()], postResponse = json({ reply: signedReply() })) {
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => {
    if (options?.method === 'POST') return postResponse;
    return json({ principalDid: envelope().principalDid, envelopes });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function compose() {
  await screen.findByRole('textbox');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Thank you' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign & send reply' }));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function knock(): ReachBearerKnock {
  return {
    requestId: 'request/one', requesterDid: envelope().requesterDid, principalDid: envelope().principalDid,
    agentLabel: '<b>Research agent</b>',
    onBehalfOf: { platform: 'foreign', externalRef: 'claimant', selfDescription: '<script>claim</script>' },
    claimVerified: false, status: 'active', issuedAt: '2026-10-17T00:00:00.000Z',
    expiresAt: '2026-10-18T00:00:00.000Z', hardCapAt: '2026-10-24T00:00:00.000Z',
  };
}

function installKnocks(knocks = [knock()], envelopes: unknown[] = []) {
  const fetchMock = vi.fn(async (_url: string, options?: RequestInit) => options?.method === 'POST'
    ? json({ blocked: true }) : json({ principalDid: envelope().principalDid, envelopes, knocks }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Reach information-only knocks', () => {
  it('renders plain-text UNVERIFIED claims and credential status with no consent or reply actions', async () => {
    installKnocks();
    const { container } = render(<ReachInboxPanel />);
    const card = within(await screen.findByRole('article', { name: 'Reach knock' }));
    expect(card.getByText('<b>Research agent</b>')).toBeDefined();
    expect(card.getByText(envelope().requesterDid)).toBeDefined();
    expect(card.getByText('UNVERIFIED onBehalfOf claim')).toBeDefined();
    expect(card.getByText('foreign: claimant — <script>claim</script>')).toBeDefined();
    expect(card.getByText('Credential status:')).toBeDefined();
    expect(card.getByText('active')).toBeDefined();
    expect(card.getByText('No action needed')).toBeDefined();
    expect(card.getAllByRole('button')).toHaveLength(1);
    expect(card.getByRole('button', { name: 'Block sender' })).toBeDefined();
    expect(card.queryByRole('textbox')).toBeNull();
    expect(card.queryByText(/approve|accept|reply/i)).toBeNull();
    expect(screen.queryByText('No reach messages yet.')).toBeNull();
    expect(container.querySelector('b, script')).toBeNull();
  });

  it('blocks all same-sender knocks and delivered cards through the knock route without signing', async () => {
    const fetchMock = installKnocks([knock(), { ...knock(), requestId: 'request_2' }], [envelope()]);
    render(<ReachInboxPanel />);
    await screen.findByRole('textbox');
    fireEvent.click(within(screen.getAllByRole('article', { name: 'Reach knock' })[0])
      .getByRole('button', { name: 'Block sender' }));
    await waitFor(() => expect(screen.getAllByText('Blocked sender')).toHaveLength(2));
    expect(screen.getByText('Blocked — replies are disabled.')).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Block sender' })).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith('/jin/api/reach/knocks/request%2Fone/block', {
      method: 'POST', credentials: 'include',
    });
  });

  it('also updates knocks when a delivered card blocks their shared sender', async () => {
    installKnocks([knock()], [envelope()]);
    render(<ReachInboxPanel />);
    await screen.findByRole('textbox');
    const delivered = screen.getAllByRole('article').find(card => card.getAttribute('aria-label') !== 'Reach knock');
    fireEvent.click(within(delivered!).getByRole('button', { name: 'Block sender' }));
    await screen.findByText('Blocked sender');
    expect(screen.queryByRole('button', { name: 'Block sender' })).toBeNull();
  });

  it.each([
    json({ error: 'Block unavailable' }, 503), json({ blocked: false }),
  ])('keeps the block available and never claims success on an unsuccessful response', async postResponse => {
    const fetchMock = installKnocks();
    render(<ReachInboxPanel />);
    const button = await screen.findByRole('button', { name: 'Block sender' });
    fetchMock.mockResolvedValueOnce(postResponse);
    fireEvent.click(button);
    await screen.findByRole('alert');
    expect(screen.queryByText('Blocked sender')).toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(button);
    await screen.findByText('Blocked sender');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('prevents duplicate block requests while pending', async () => {
    const fetchMock = installKnocks();
    render(<ReachInboxPanel />);
    const button = await screen.findByRole('button', { name: 'Block sender' });
    let finish: (response: Response) => void = () => { throw new Error('Block not started'); };
    fetchMock.mockImplementationOnce(async () => new Promise<Response>(resolve => { finish = resolve; }));
    fireEvent.click(button);
    const pending = screen.getByRole('button', { name: 'Blocking sender…' });
    expect((pending as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pending);
    expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
    finish(json({ blocked: true }));
    await screen.findByText('Blocked sender');
  });

  it.each(['blocked', 'revoked'])('hides foreign-principal knocks and honors persisted %s status', async status => {
    installKnocks([{ ...knock(), status }, { ...knock(), requestId: 'foreign', principalDid: 'did:other' }]);
    render(<ReachInboxPanel />);
    await screen.findByText('Blocked sender');
    expect(screen.getAllByRole('article')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Block sender' })).toBeNull();
  });
});

describe('Reach sender blocking', () => {
  it('blocks in one tap without a local signing key and hides all of that sender’s composers and replies', async () => {
    const fetchMock = installFetch([
      envelope(),
      { ...envelope(), reachId: 'reach_2', reply: signedReply('Private reply'), replyPublishedAt: '2026-10-17T01:00:00.000Z' },
    ], json({ blocked: true }));
    render(<ReachInboxPanel />);
    await screen.findByText('Private reply');
    fireEvent.click(screen.getAllByRole('button', { name: 'Block sender' })[0]);
    await waitFor(() => expect(screen.getAllByText('Blocked — replies are disabled.')).toHaveLength(2));
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByText('Private reply')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Block sender' })).toBeNull();
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual(['/jin/api/reach/reach_1/block', { method: 'POST', credentials: 'include' }]);
  });

  it('does not claim success on failure and clears the error after a successful retry', async () => {
    const fetchMock = installFetch(undefined, json({ error: 'Block unavailable' }, 503));
    render(<ReachInboxPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Block sender' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Block unavailable');
    expect(screen.queryByText('Blocked — replies are disabled.')).toBeNull();
    expect(screen.getByRole('textbox')).toBeDefined();
    fetchMock.mockResolvedValueOnce(json({ blocked: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Block sender' }));
    await screen.findByText('Blocked — replies are disabled.');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('rejects a response which does not confirm blocked:true', async () => {
    installFetch(undefined, json({ blocked: false }));
    render(<ReachInboxPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Block sender' }));
    expect((await screen.findByRole('alert')).textContent).toContain('did not confirm');
    expect(screen.queryByText('Blocked — replies are disabled.')).toBeNull();
  });

  it('honors persisted blocked state when refreshing', async () => {
    const fetchMock = installFetch();
    render(<ReachInboxPanel />);
    await screen.findByRole('textbox');
    fetchMock.mockResolvedValueOnce(json({
      principalDid: envelope().principalDid,
      envelopes: [{ ...envelope(), blocked: true, reply: signedReply('Hidden reply') }],
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh reach inbox' }));
    await screen.findByText('Blocked — replies are disabled.');
    expect(screen.queryByText('Hidden reply')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Retry signed reply' })).toBeNull();
  });
});

describe('Reach pending publication recovery', () => {
  it('retries the stored signed event after reload without a browser key or a new signature', async () => {
    const reply = signedReply();
    const fetchMock = installFetch([{ ...envelope(), reply }]);
    render(<ReachInboxPanel />);
    await screen.findByText('Reply signed — publication pending.');
    expect(screen.queryByText('Replied — signed by you')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry signed reply' }));
    await screen.findByText('Replied — signed by you');
    expect(screen.queryByRole('button', { name: 'Retry signed reply' })).toBeNull();
    const post = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST');
    expect(post?.[0]).toBe('/jin/api/reach/reach_1/reply');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      message: reply.payload.message, issuedAt: reply.payload.issuedAt, signature: reply.payload.signature,
    });
  });

  it('keeps the immutable retry available if publication fails again', async () => {
    installFetch([{ ...envelope(), reply: signedReply() }], json({ error: 'Publication unavailable' }, 503));
    render(<ReachInboxPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry signed reply' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Publication unavailable');
    expect(screen.getByText('Reply signed — publication pending.')).toBeDefined();
    expect(screen.queryByText('Replied — signed by you')).toBeNull();
    expect((screen.getByRole('button', { name: 'Retry signed reply' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('ReachInboxPanel', () => {
  it('renders requester metadata and claims as untrusted plain text', async () => {
    installFetch();
    const { container } = render(<ReachInboxPanel />);
    expect(await screen.findByText(envelope().message)).toBeDefined();
    expect(screen.getByText('UNVERIFIED onBehalfOf claim')).toBeDefined();
    expect(screen.getByText('foreign: external-1 — <b>Claim</b>')).toBeDefined();
    expect(screen.getByText('did:imajin:agent')).toBeDefined();
    expect(screen.getByText('verified')).toBeDefined();
    expect(screen.getByText('Research')).toBeDefined();
    expect(screen.getByText(envelope().transcriptHash)).toBeDefined();
    expect(container.querySelector('img, b')).toBeNull();
  });

  it('one tap signs the full canonical event, posts only the reply contract, and displays the reply', async () => {
    localStorage.setItem('imajin_keypair', JSON.stringify(pair));
    const fetchMock = installFetch();
    render(<ReachInboxPanel />);
    await compose();
    expect(await screen.findByText('Replied — signed by you')).toBeDefined();
    expect(screen.getByText('Thank you')).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0][0]).toBe('/jin/api/reach/reach_1/reply');
    const sent = JSON.parse(String(posts[0][1]?.body)) as {
      message: string; issuedAt: string; signature: { keyId: string; alg: string; sig: string };
    };
    expect(Object.keys(sent).sort()).toEqual(['issuedAt', 'message', 'signature']);
    const event = reachReplyEvent(envelope(), sent.message, sent.issuedAt);
    expect(sent.signature.keyId).toBe(pair.publicKey);
    expect(sent.signature.alg).toBe('ed25519');
    expect(authCrypto.verifySync(sent.signature.sig, canonicalize(event), pair.publicKey)).toBe(true);
    expect(authCrypto.verifySync(sent.signature.sig, canonicalize({ ...event, issuer: 'did:imajin:other' }), pair.publicKey)).toBe(false);
  });

  it('refuses to POST without a browser key and keeps the composer usable', async () => {
    const fetchMock = installFetch();
    render(<ReachInboxPanel />);
    await compose();
    expect((await screen.findByRole('alert')).textContent).toContain('No browser signing key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('shows malformed-key errors without sending unsigned', async () => {
    localStorage.setItem('imajin_keypair', '{bad json');
    const fetchMock = installFetch();
    render(<ReachInboxPanel />);
    await compose();
    expect((await screen.findByRole('alert')).textContent).toContain('Invalid browser signing key');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces server failures and retries the exact original signed request', async () => {
    localStorage.setItem('imajin_keypair', JSON.stringify(pair));
    const fetchMock = installFetch(undefined, json({ error: 'publish_pending' }, 503));
    render(<ReachInboxPanel />);
    await compose();
    expect((await screen.findByRole('alert')).textContent).toBe('publish_pending');
    const first = fetchMock.mock.calls.find(([, options]) => options?.method === 'POST')?.[1]?.body;
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Retry signed reply' }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(2));
    const posts = fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST');
    expect(posts[1][1]?.body).toBe(first);
  });

  it('disables duplicate submission while the request is pending', async () => {
    localStorage.setItem('imajin_keypair', JSON.stringify(pair));
    const fetchMock = installFetch();
    let resolvePost: (response: Response) => void = () => { throw new Error('POST not started'); };
    fetchMock.mockImplementation(async (_url, options) => {
      if (options?.method === 'POST') return new Promise<Response>(resolve => { resolvePost = resolve; });
      return json({ principalDid: envelope().principalDid, envelopes: [envelope()] });
    });
    render(<ReachInboxPanel />);
    await compose();
    const pendingButton = await screen.findByRole('button', { name: 'Sending signed reply…' });
    expect((pendingButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(pendingButton);
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1));
    resolvePost(json({ reply: signedReply() }));
    await screen.findByText('Replied — signed by you');
  });

  it('shows existing published replies as plain text without a composer', async () => {
    installFetch([{ ...envelope(), reply: signedReply('<script>reply</script>'), replyPublishedAt: '2026-10-17T01:00:00.000Z' }]);
    render(<ReachInboxPanel />);
    expect(await screen.findByText('<script>reply</script>')).toBeDefined();
    expect(screen.getByText('Replied — signed by you')).toBeDefined();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('does not offer another reply for a supplied pending state', async () => {
    installFetch([{ ...envelope(), state: 'pending' }]);
    render(<ReachInboxPanel />);
    await screen.findByText('Reply pending — replies are disabled.');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it.each([401, 403])('is hidden for unauthorized or act-as responses (%s)', async status => {
    const fetchMock = vi.fn(async () => json({ error: 'act_as_not_permitted' }, status));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ReachInboxPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it('hides an explicitly supplied act-as context and foreign principal rows', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ principalDid: envelope().principalDid, envelopes: [envelope()], actAs: { actingDid: 'other' } }));
    vi.stubGlobal('fetch', fetchMock);
    const { container } = render(<ReachInboxPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(container.firstChild).toBeNull();
  });

  it('refuses to show envelopes owned by another principal', async () => {
    installFetch([{ ...envelope(), principalDid: 'did:imajin:other' }]);
    render(<ReachInboxPanel />);
    await screen.findByRole('region', { name: 'Reach inbox' });
    expect(screen.queryByRole('article')).toBeNull();
  });

  it('shows network errors and refreshes to an empty inbox', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce(json({ principalDid: envelope().principalDid, envelopes: [] }));
    vi.stubGlobal('fetch', fetchMock);
    render(<ReachInboxPanel />);
    expect((await screen.findByRole('alert')).textContent).toBe('network unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh reach inbox' }));
    expect(await screen.findByText('No reach messages yet.')).toBeDefined();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
