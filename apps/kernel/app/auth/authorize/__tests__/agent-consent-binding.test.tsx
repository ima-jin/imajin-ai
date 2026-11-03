// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AgentConsentBinding } from '../agent-consent-binding';

const AGENT = 'did:imajin:jin';
const HUMAN = 'did:imajin:ryan';
const ORG = 'did:imajin:artifact';
const onChange = vi.fn();
function choices(principals = [HUMAN]) {
  return {
    agent: { did: AGENT, handle: 'jin' },
    principals: principals.map(did => ({ did, handle: did === HUMAN ? 'ryan' : 'artifact', name: null })),
  };
}
beforeEach(() => {
  onChange.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => choices() })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
function mount(initialAgentDid = AGENT) {
  render(<AgentConsentBinding initialAgentDid={initialAgentDid} onChange={onChange} />);
}
async function load() {
  fireEvent.click(screen.getByRole('button', { name: 'Load assigned identities' }));
  return screen.findByRole('combobox');
}
it('shows the agent DID and requires an explicit choice even for one principal', async () => {
  mount();
  const select = await load();
  expect((select as HTMLSelectElement).value).toBe('');
  expect(onChange).toHaveBeenLastCalledWith(null);
  expect(screen.queryByRole('status')).toBeNull();
  fireEvent.change(select, { target: { value: HUMAN } });
  expect(onChange).toHaveBeenLastCalledWith({ agentDid: AGENT, principalDid: HUMAN });
  expect(screen.getByRole('status').textContent).toContain(`${AGENT} will act for ${HUMAN}`);
  expect(vi.mocked(fetch).mock.calls[0][0]).toBe(`/oauth/agent-bindings?agent_did=${encodeURIComponent(AGENT)}`);
});
it('offers multiple authorized principals without selecting the first', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => choices([HUMAN, ORG]) } as Response);
  mount();
  const select = await load();
  expect((select as HTMLSelectElement).value).toBe('');
  fireEvent.change(select, { target: { value: ORG } });
  expect(onChange).toHaveBeenLastCalledWith({ agentDid: AGENT, principalDid: ORG });
  fireEvent.change(select, { target: { value: '' } });
  expect(onChange).toHaveBeenLastCalledWith(null);
});
it('invalidates the choice as soon as the agent changes', async () => {
  mount();
  fireEvent.change(await load(), { target: { value: HUMAN } });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'did:imajin:artifact-jin' } });
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  expect(onChange).toHaveBeenLastCalledWith(null);
});
it('does not load without an agent DID', () => {
  mount('');
  expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it('shows typed assignment/admin refusals and never offers a binding', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: false, json: async () => ({
    error: 'agent_assignment_required', error_description: 'Restore on /auth/agents.',
  }) } as Response);
  mount();
  fireEvent.click(screen.getByRole('button'));
  expect((await screen.findByRole('alert')).textContent).toContain('agent_assignment_required');
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(onChange).toHaveBeenLastCalledWith(null);
});
it('uses safe fallback messages for missing descriptions and network failures', async () => {
  vi.mocked(fetch).mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'agent_consent_forbidden' }) } as Response);
  mount();
  fireEvent.click(screen.getByRole('button'));
  expect((await screen.findByRole('alert')).textContent).toContain('Agent consent refused.');
  vi.mocked(fetch).mockRejectedValueOnce(new Error('network failed'));
  fireEvent.click(screen.getByRole('button'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('agent_binding_unavailable'));
});
it('drops a stale result, including a stale failure, after the operator changes agent', async () => {
  let finish: (response: Response) => void = () => {};
  vi.mocked(fetch).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  mount();
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('button').textContent).toContain('Loading');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'did:imajin:artifact-jin' } });
  await act(async () => { finish({ ok: true, json: async () => choices() } as Response); });
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});
