// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
const h = vi.hoisted(() => ({ query: '', commitError: false, commits: [] as Record<string, unknown>[] }));
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams(h.query) }));
import AuthorizePage from '../page';

const AGENT = 'did:imajin:jin';
const HUMAN = 'did:imajin:ryan';
beforeEach(() => {
  h.query = new URLSearchParams({
    client_id: 'app_gateway', agent_did: AGENT, scope: 'media:read discovery:read',
    code_challenge: 'local-challenge', resource: 'http://localhost/mcp',
    redirect_uri: 'http://localhost/callback',
  }).toString();
  h.commits = [];
  h.commitError = false;
  vi.stubGlobal('fetch', vi.fn(async (url, options) => {
    if (url === '/profile/api/auth/session') return { json: async () => ({ did: HUMAN }) };
    if (String(url).startsWith('/api/registry/apps/')) return { ok: true, json: async () => ({
      id: 'app_gateway', name: 'Gateway fixture', description: null, appDid: 'did:imajin:client',
      homepageUrl: null, logoUrl: null, callbackUrl: 'http://localhost/callback',
      requestedScopes: ['media:read', 'discovery:read'],
    }) };
    if (String(url).startsWith('/oauth/agent-bindings')) return { ok: true, json: async () => ({
      agent: { did: AGENT, handle: 'jin' }, principals: [{ did: HUMAN, handle: 'ryan', name: 'Ryan' }],
    }) };
    h.commits.push(JSON.parse(options!.body as string));
    return { ok: !h.commitError, json: async () => h.commitError
      ? { error: 'agent_assignment_required', error_description: 'Restore the assignment on /auth/agents.' }
      : { redirect: `${globalThis.location.origin}/#approved` } };
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function mount() {
  render(<AuthorizePage />);
  return screen.findByRole('button', { name: 'Authorize', exact: true });
}
async function choose() {
  fireEvent.click(screen.getByRole('button', { name: 'Load assigned identities' }));
  fireEvent.change(await screen.findByRole('combobox'), { target: { value: HUMAN } });
}
it('blocks approval until explicit selection, then commits the fixed agent/principal pair', async () => {
  const approve = await mount();
  expect((approve as HTMLButtonElement).disabled).toBe(true);
  await choose();
  expect((approve as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(approve);
  await waitFor(() => expect(h.commits).toHaveLength(1));
  expect(h.commits[0]).toMatchObject({
    client_id: 'app_gateway', agent_did: AGENT, acting_for: HUMAN,
    scope: 'media:read discovery:read', code_challenge_method: 'S256',
  });
});
it('invalidates parent approval when the operator changes agent', async () => {
  const approve = await mount();
  await choose();
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'did:imajin:artifact-jin' } });
  expect((approve as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(approve);
  expect(h.commits).toEqual([]);
});
it('preserves legacy human OAuth when the optional agent mode is not selected', async () => {
  h.query = h.query.replaceAll(`agent_did=${encodeURIComponent(AGENT)}&`, '');
  const approve = await mount();
  expect((approve as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(approve);
  await waitFor(() => expect(h.commits).toHaveLength(1));
  expect(h.commits[0]).not.toHaveProperty('agent_did');
  expect(h.commits[0]).not.toHaveProperty('acting_for');
});
it('clears an agent binding when agent mode is turned off', async () => {
  const approve = await mount();
  await choose();
  fireEvent.click(screen.getByRole('checkbox', { name: /Authorize an agent/ }));
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(approve);
  await waitFor(() => expect(h.commits).toHaveLength(1));
  expect(h.commits[0]).not.toHaveProperty('acting_for');
});
it('shows the restoration control when live assignment changes before consent commit', async () => {
  h.commitError = true;
  const approve = await mount();
  await choose();
  fireEvent.click(approve);
  expect(await screen.findByText('Restore the assignment on /auth/agents.')).toBeTruthy();
});
it('does not expose agent OAuth mode on the existing keypair-app consent lane', async () => {
  h.query = 'app_id=app_gateway&scopes=media:read';
  const approve = await mount();
  expect(screen.queryByRole('checkbox', { name: /Authorize an agent/ })).toBeNull();
  fireEvent.click(approve);
  await waitFor(() => expect(h.commits).toHaveLength(1));
  expect(h.commits[0]).toEqual({ appId: 'app_gateway', scopes: ['media:read'], state: null });
});
