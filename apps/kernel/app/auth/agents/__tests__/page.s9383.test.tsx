// @vitest-environment jsdom
/**
 * AgentsPage — typescript:S9383 (#2568).
 *
 * "Copy OpenClaw Config" wraps the clipboard promise chain in
 * `fireAndForget(...)`. These tests create an agent to reach the copy button,
 * pin the unchanged success path, and check that a clipboard rejection is
 * logged through console.error instead of rejecting unhandled.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@imajin/config', () => ({
  buildPublicUrlAbsolute: () => 'https://kernel.test',
}));

import AgentsPage from '../page';

function res(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function installFetch() {
  const spy = vi.fn(async (rawUrl: string, init?: RequestInit) => {
    const url = String(rawUrl);
    if (url.endsWith('/auth/api/agents') && init?.method === 'POST') {
      return res({
        did: 'did:imajin:new-agent',
        handle: 'veteze-jin-travel',
        displayName: 'Travel',
        keypair: { publicKey: 'pub', privateKey: 'priv' },
      });
    }
    if (url.endsWith('/auth/api/agents')) return res({ agents: [] });
    if (url.endsWith('/auth/api/session')) return res({ did: 'did:imajin:ryan', handle: 'ryan' });
    if (url.endsWith('/auth/api/knock/pending')) return res({ knocks: [] });
    return res({});
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

function installClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

async function createAgentAndShowCopyButton() {
  installFetch();
  render(<AgentsPage />);
  await waitFor(() => expect(screen.queryByText('Loading agents…')).toBeNull());
  fireEvent.click(screen.getByText('+ Create Agent'));
  fireEvent.change(screen.getByLabelText('Handle'), { target: { value: 'veteze-jin-travel' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create Agent' }));
  return screen.findByText('Copy OpenClaw Config');
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AgentsPage copy OpenClaw config', () => {
  it('copies the config snippet and reports success', async () => {
    const writeText = vi.fn(async () => undefined);
    installClipboard(writeText);
    fireEvent.click(await createAgentAndShowCopyButton());

    await waitFor(() => expect(screen.getByText('Config copied to clipboard')).toBeDefined());
    expect(writeText).toHaveBeenCalledTimes(1);
    const snippet = String((writeText.mock.calls[0] as unknown[])[0]);
    expect(snippet).toContain('did:imajin:new-agent');
    expect(snippet).toContain('.agent-veteze-jin-travel.json');
  });

  it('logs a clipboard rejection through console.error without unhandled rejection', async () => {
    const err = new Error('clipboard denied');
    installClipboard(vi.fn(() => Promise.reject(err)));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fireEvent.click(await createAgentAndShowCopyButton());

    await waitFor(() =>
      expect(errorSpy).toHaveBeenCalledWith('[auth:agents:clipboard] unhandled async error', err),
    );
    expect(screen.queryByText('Config copied to clipboard')).toBeNull();
  });
});
