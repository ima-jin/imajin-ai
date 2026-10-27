// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useProvisionSiteOwners } from '../provision-site-owners';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('controlled provision site owners', () => {
  it('does not fetch before the operator gate opens and disables selection while loading', async () => {
    let resolve!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done; }));
    vi.stubGlobal('fetch', fetch);
    const { result, rerender } = renderHook(({ visible }) => useProvisionSiteOwners(visible), { initialProps: { visible: false } });
    expect(fetch).not.toHaveBeenCalled();
    rerender({ visible: true });
    expect(result.current.loading).toBe(true);
    await act(async () => { resolve(Response.json([
      { groupDid: 'did:imajin:family', scope: 'family', role: 'admin', name: null, handle: null },
      { groupDid: 'did:imajin:community', scope: 'community', role: 'owner', name: null, handle: null },
    ])); });
    expect(result.current.groups.map(group => group.groupDid)).toEqual(['did:imajin:family', 'did:imajin:community']);
    expect(result.current.loading).toBe(false);
  });
  it.each(['network', 'malformed'])('keeps the list empty on %s failure', async failure => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      if (failure === 'network') throw new Error('offline');
      return Response.json({ error: 'not a group list' });
    }));
    const { result } = renderHook(() => useProvisionSiteOwners(true));
    await waitFor(() => expect(result.current.error).toContain('Unable to load groups'));
    expect(result.current.groups).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
  it.each([true, false])('ignores a late response after unmount (success=%s)', async success => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    vi.stubGlobal('fetch', fetch);
    const { result, unmount } = renderHook(() => useProvisionSiteOwners(true));
    unmount();
    await act(async () => { finish(Response.json([], { status: success ? 200 : 403 })); });
    expect(result.current.groups).toEqual([]);
    expect(result.current.error).toBe('');
  });
});
