// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RunBrief } from '../run-brief';
import BriefSettingsPage from '../brief-settings/page';
import { RunsPanelDetail } from '../runs-panel-detail';
import { runLoop } from '@/src/lib/jin/__tests__/runs-fixture';

const text = 'Exact brief 今人\n';
const hash = createHash('sha256').update(text).digest('hex');
const brief = { hash, assetId: 'asset_brief', storage: 'full-text', browserTesting: 'no' };
const response = (body: unknown, ok = true) => ({ ok, json: async () => body });
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('TextDecoder', TextDecoder);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('run brief', () => {
  it('renders the brief asset link and event hash in the Runs-lane history', async () => {
    const loop = runLoop();
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve(response(url.includes('ancestor=')
      ? { isOperator: true, page: { loops: [], nextCursor: null } }
      : { isOperator: true, detail: { loop, events: [{
        id: 'e1', type: 'loop.started', issuer: 'did:imajin:node', occurredAt: loop.startedAt, payload: { brief },
      }] } }))));
    render(<RunsPanelDetail loopId={loop.loopId} onSelect={vi.fn()} onDenied={vi.fn()} />);
    const link = await screen.findByRole('link', { name: 'Brief asset: asset_brief' });
    expect(link.getAttribute('href')).toBe('/media/api/assets/asset_brief');
    expect(screen.getByText(`SHA-256: ${hash}`)).toBeDefined();
  });
  it('opens exact text and verifies downloaded bytes against the dispatch hash', async () => {
    const buffer = new TextEncoder().encode(text).buffer;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => buffer }));
    render(<RunBrief value={brief} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open and verify brief' }));
    expect(await screen.findByText('Hash matches dispatch event')).toBeDefined();
    expect(screen.getByText(text.trim()).tagName).toBe('PRE');
    expect(fetch).toHaveBeenCalledWith('/media/api/assets/asset_brief', expect.objectContaining({
      credentials: 'include', cache: 'no-store',
    }));
  });
  it('does not display tampered text as a verified brief', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new TextEncoder().encode('tampered').buffer }));
    render(<RunBrief value={brief} />);
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText(/Hash mismatch/)).toBeDefined();
    expect(screen.queryByText('tampered')).toBeNull();
  });
  it.each(['denied', 'network'])('fails closed on %s reads', async kind => {
    vi.stubGlobal('fetch', kind === 'network' ? vi.fn().mockRejectedValue(new Error('offline')) : vi.fn().mockResolvedValue({ ok: false }));
    render(<RunBrief value={brief} />);
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('Brief unavailable or access denied')).toBeDefined();
  });
  it('renders hash-only without a link, text or fetch', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<RunBrief value={{ ...brief, storage: 'hash-only', assetId: null, browserTesting: null }} />);
    expect(screen.getByText('brief stored as hash only')).toBeDefined();
    expect(screen.getByText('Browser testing: not specified')).toBeDefined();
    expect(screen.queryByRole('link')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('ignores legacy or invalid descriptors', () => {
    const { container } = render(<RunBrief value={{ ...brief, assetId: '../unsafe' }} />);
    expect(container.innerHTML).toBe('');
  });
});

describe('brief settings page', () => {
  it('loads full-text default and lets the operator switch to hash-only with signed confirmation', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ storage: 'full-text' }))
      .mockResolvedValueOnce(response({ storage: 'hash-only', attestationId: 'att_signed' })));
    render(<BriefSettingsPage />);
    expect(screen.getByText(/anyone holding a guess.*plain SHA-256 hash/)).toBeDefined();
    await waitFor(() => expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('full-text'));
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'hash-only' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save brief setting' }));
    expect(await screen.findByText('Saved · signed event att_signed')).toBeDefined();
    expect(fetch).toHaveBeenLastCalledWith('/jin/api/brief-settings', expect.objectContaining({
      method: 'PUT', body: '{"storage":"hash-only"}',
    }));
  });
  it.each([response({}, false), response({ storage: 'corrupt' }), null])('does not enable writes on unreadable preferences', async value => {
    vi.stubGlobal('fetch', value ? vi.fn().mockResolvedValue(value) : vi.fn().mockRejectedValue(new Error('offline')));
    render(<BriefSettingsPage />);
    expect(await screen.findByText(/Brief settings unavailable/)).toBeDefined();
    expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  });
  it.each([response({}, false), response({}), null])('does not claim a signed save on failure', async value => {
    const fetcher = vi.fn().mockResolvedValueOnce(response({ storage: 'hash-only' }));
    if (value) fetcher.mockResolvedValueOnce(value);
    else fetcher.mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    render(<BriefSettingsPage />);
    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button'));
    expect(await screen.findByText('Brief setting was not saved. Try again.')).toBeDefined();
  });
});
