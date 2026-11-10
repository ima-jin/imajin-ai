// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AlphaSubmissionsPanel } from '../alpha-submissions-panel';
import { ALPHA_INTENTS } from '@/src/lib/alpha/contract';

const acting = vi.hoisted(() => ({ headers: {} as Record<string, string> }));
vi.mock('@imajin/ui/server', () => ({ getActingAsHeaders: () => acting.headers }));
const row = {
  id: 'request-1', company: 'Example Company', name: 'Example Person', email: 'person@example.com',
  intent: 'demo', purpose: '<script>Never execute this</script>', createdAt: '2026-11-10T00:00:00Z',
};
const response = (submissions = [row], hasMore = false) => Response.json({ submissions, hasMore });
function install() {
  const transport = vi.fn().mockImplementation(async () => response());
  vi.stubGlobal('fetch', transport);
  return transport;
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); acting.headers = {}; });
describe('/jin alpha operator list', () => {
  it('stays invisible until authorized; renders collapsed summaries and escaped private details', async () => {
    const transport = install();
    const { container } = render(<AlphaSubmissionsPanel />);
    expect(container.textContent).toBe('');
    await screen.findByRole('region', { name: 'Alpha requests' });
    expect(screen.getByText(/Example Company · Book a demo/)).toBeDefined();
    expect(container.querySelector('details')?.open).toBe(false);
    fireEvent.click(container.querySelector('summary')!);
    expect(screen.getByText(row.email)).toBeDefined();
    expect(screen.getByText(row.purpose)).toBeDefined();
    expect(container.querySelector('script')).toBeNull();
    expect(transport).toHaveBeenCalledWith('/jin/api/alpha-submissions?offset=0', expect.objectContaining({
      credentials: 'include', cache: 'no-store', headers: {},
    }));
  });
  it.each(ALPHA_INTENTS)('filters %s server-side, then returns to all requests', async intent => {
    const transport = install();
    render(<AlphaSubmissionsPanel />);
    await screen.findByText(row.email);
    fireEvent.change(screen.getByRole('combobox', { name: 'Request type' }), { target: { value: intent } });
    await waitFor(() => expect(transport).toHaveBeenLastCalledWith(`/jin/api/alpha-submissions?offset=0&intent=${intent}`, expect.anything()));
    await screen.findByText(row.email);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '' } });
    await waitFor(() => expect(transport).toHaveBeenLastCalledWith('/jin/api/alpha-submissions?offset=0', expect.anything()));
  });
  it('pages older/newer and resets offset when filtering', async () => {
    const transport = install();
    transport.mockResolvedValueOnce(response([row], true));
    render(<AlphaSubmissionsPanel />);
    await screen.findByText(row.email);
    expect((screen.getByRole('button', { name: 'Newer requests' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Older requests' }));
    await waitFor(() => expect(transport).toHaveBeenLastCalledWith('/jin/api/alpha-submissions?offset=50', expect.anything()));
    await screen.findByText(row.email);
    expect((screen.getByRole('button', { name: 'Older requests' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Newer requests' }));
    await screen.findByText(row.email);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'demo' } });
    await waitFor(() => expect(transport).toHaveBeenLastCalledWith('/jin/api/alpha-submissions?offset=0&intent=demo', expect.anything()));
  });
  it.each([401, 403])('hides everything after HTTP %s on refresh', async status => {
    const transport = install();
    const { container } = render(<AlphaSubmissionsPanel />);
    await screen.findByText(row.email);
    transport.mockResolvedValueOnce(new Response(null, { status }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh alpha requests' }));
    await waitFor(() => expect(container.textContent).toBe(''));
    expect(screen.queryByText(row.email)).toBeNull();
  });
  it.each(['http', 'network', 'json', 'shape'])('clears stale rows on %s failure and offers retry', async failure => {
    const transport = install();
    render(<AlphaSubmissionsPanel />);
    await screen.findByText(row.email);
    if (failure === 'network') transport.mockRejectedValueOnce(new Error('private detail'));
    else if (failure === 'json') transport.mockResolvedValueOnce(new Response('invalid'));
    else if (failure === 'shape') transport.mockResolvedValueOnce(Response.json({ submissions: [{ ...row, intent: 'unknown' }], hasMore: false }));
    else transport.mockResolvedValueOnce(new Response(null, { status: 503 }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh alpha requests' }));
    await screen.findByRole('alert');
    expect(screen.queryByText(row.email)).toBeNull();
    expect(screen.queryByText('private detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh alpha requests' }));
    await screen.findByText(row.email);
  });
  it('renders an empty filtered list without losing the filter controls', async () => {
    const transport = install();
    transport.mockResolvedValueOnce(response([]));
    render(<AlphaSubmissionsPanel />);
    await screen.findByText('No matching alpha requests.');
    expect(screen.getByRole('combobox')).toBeDefined();
  });
  it.each(['imajin:acting-as-changed', 'imajin:session-changed', 'storage'])('discards private data immediately on %s and ignores late results', async eventName => {
    const transport = install();
    render(<AlphaSubmissionsPanel />);
    await screen.findByText(row.email);
    let finish!: (response: Response) => void;
    transport.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh alpha requests' }));
    acting.headers = { 'X-Acting-As': 'org' };
    transport.mockResolvedValueOnce(new Response(null, { status: 403 }));
    fireEvent(globalThis, eventName === 'storage' ? new StorageEvent('storage', { key: 'imajin:acting-as' }) : new Event(eventName));
    expect(screen.queryByText(row.email)).toBeNull();
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(3));
    await act(async () => { finish(response()); });
    expect(screen.queryByText(row.email)).toBeNull();
    expect(transport.mock.calls.at(-1)?.[1].headers).toEqual({ 'X-Acting-As': 'org' });
  });
  it('ignores unrelated storage changes and reloads when storage is cleared', async () => {
    const transport = install();
    render(<AlphaSubmissionsPanel />);
    await screen.findByText(row.email);
    fireEvent(globalThis, new StorageEvent('storage', { key: 'unrelated' }));
    expect(transport).toHaveBeenCalledOnce();
    fireEvent(globalThis, new StorageEvent('storage', { key: null }));
    await waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
  });
  it.each(['response', 'error'])('aborts the request and ignores a late %s after unmount', async outcome => {
    const transport = install();
    let finish!: (response: Response) => void;
    let fail!: (error: Error) => void;
    const { container, unmount } = render(<AlphaSubmissionsPanel />);
    await screen.findByText(row.email);
    transport.mockImplementationOnce(() => new Promise<Response>((resolve, reject) => { finish = resolve; fail = reject; }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh alpha requests' }));
    const signal = transport.mock.calls.at(-1)?.[1].signal as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
    const json = vi.fn().mockResolvedValue({ submissions: [row], hasMore: false });
    await act(async () => {
      if (outcome === 'response') finish({ ok: true, status: 200, json } as unknown as Response);
      else fail(new Error('late error'));
    });
    expect(json).not.toHaveBeenCalled();
    expect(container.childElementCount).toBe(0);
    expect(transport).toHaveBeenCalledTimes(2);
  });
});
