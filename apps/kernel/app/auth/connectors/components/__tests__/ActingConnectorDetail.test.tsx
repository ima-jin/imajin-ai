// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getConnector } from '@/src/lib/kernel/connector-registry';
import { ActingConnectorDetail } from '../ActingConnectorDetail';

const state = vi.hoisted(() => ({ acting: null as string | null }));
vi.mock('@imajin/ui/server', () => ({ getActingAs: () => state.acting }));
vi.mock('../ConnectorDetail', () => ({
  ConnectorDetail: ({ entry }: { entry: { id: string } }) => <p>Personal {entry.id}</p>,
}));
vi.mock('../OrgConnectorSection', () => ({
  default: ({ orgDid, humanSession, connectorId }: { orgDid: string; humanSession: boolean; connectorId: string }) =>
    <p>Org {orgDid} {connectorId} {humanSession ? 'human' : 'read-only'}</p>,
}));
afterEach(() => { cleanup(); state.acting = null; vi.unstubAllGlobals(); });
const entry = getConnector('anthropic')!;

describe('connector detail acting identity', () => {
  it('mounts personal mode without deriving ownership from a raw session DID or handle', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    render(<ActingConnectorDetail entry={entry} />);
    expect(await screen.findByText('Personal anthropic')).toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['business', 'community', 'family'])('uses selected %s org rather than session identity', async scope => {
    state.acting = `did:imajin:${scope}`;
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      id: 'did:imajin:personal', handle: 'personal-handle', scope: 'actor', subtype: 'human',
    })));
    render(<ActingConnectorDetail entry={entry} />);
    expect(await screen.findByText(`Org ${state.acting} anthropic human`)).toBeDefined();
    expect(document.body.textContent).not.toMatch(/personal-handle|did:imajin:personal/);
    expect(screen.queryByText('Personal anthropic')).toBeNull();
  });
  it('unmounts the old org card when acting identity changes and returns to personal mode', async () => {
    state.acting = 'did:imajin:artifact';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ scope: 'actor', subtype: 'human' })));
    render(<ActingConnectorDetail entry={entry} />);
    await screen.findByText('Org did:imajin:artifact anthropic human');
    await act(async () => {
      state.acting = 'did:imajin:anotherorg';
      globalThis.dispatchEvent(new Event('imajin:acting-as-changed'));
    });
    await screen.findByText('Org did:imajin:anotherorg anthropic human');
    expect(document.body.textContent).not.toContain('artifact');
    await act(async () => {
      state.acting = null;
      globalThis.dispatchEvent(new Event('imajin:acting-as-changed'));
    });
    expect(await screen.findByText('Personal anthropic')).toBeDefined();
  });
  it.each([401, 503])('never enables org management after session read failure %i', async status => {
    state.acting = 'did:imajin:artifact';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({}, { status })));
    render(<ActingConnectorDetail entry={entry} />);
    expect(await screen.findByText('Org did:imajin:artifact anthropic read-only')).toBeDefined();
  });
  it('never enables management for an agent session', async () => {
    state.acting = 'did:imajin:artifact';
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ scope: 'actor', subtype: 'agent' })));
    render(<ActingConnectorDetail entry={entry} />);
    expect(await screen.findByText('Org did:imajin:artifact anthropic read-only')).toBeDefined();
  });
});
