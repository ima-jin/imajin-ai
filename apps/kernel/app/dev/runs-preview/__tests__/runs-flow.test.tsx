// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunsPanel } from '@/app/jin/runs-panel';
import { dispatchSessionCommand, prepareSignedSessionCommand, type SessionCommandClient } from '@/app/jin/session-command-client';
import { createRunsPreviewTransport } from '../transport';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));
beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubGlobal('crypto', webcrypto);
});
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  sessionStorage.clear();
});

describe('real Runs components on exact-contract fixture transport', () => {
  it('signs send/spawn and inline native approve/deny through the shared endpoint, then displays attested results', async () => {
    // Only polling is virtual: Ed25519 signing and the fixture's delayed
    // outcomes must finish before we advance the components' refresh clocks.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const fixture = await createRunsPreviewTransport();
    const client: SessionCommandClient = {
      prepare: (loopId, type, payload) =>
        prepareSignedSessionCommand(loopId, type, payload, fixture.keypair),
      dispatch: dispatchSessionCommand,
    };
    const transport = vi.fn(fixture.fetcher);
    vi.stubGlobal('fetch', transport);
    const view = render(<RunsPanel client={client} />);
    try {
      const cards = await screen.findAllByTestId('run-card');
      const session = cards.find((card) => card.textContent?.includes('openclaw.session'))!;
      fireEvent.click(within(session).getByRole('button', { expanded: false }));
      await within(session).findByTestId('run-composer');
      expect(within(session).getAllByRole('button', { name: 'Allow once' })).toHaveLength(2);
      fireEvent.click(within(session).getAllByRole('button', { name: 'Allow once' })[0]);
      await waitFor(() => expect(transport.mock.calls.some(([url]) => String(url).endsWith('/fixture-allow/decision'))).toBe(true));
      const decisionCall = transport.mock.calls.find(([url]) => String(url).endsWith('/fixture-allow/decision'))!;
      const decisionBody = JSON.parse(String(decisionCall[1]?.body));
      expect(decisionBody.sessionCommand.type).toBe('session.approve');
      expect(decisionBody.sessionCommand.countersignature.sig).toMatch(/^[a-f0-9]{128}$/);
      expect(decisionBody.sessionCommand.payload).toEqual({ loopId: 'fixture-session', approvalId: 'native-allow', kind: 'exec' });
      await waitFor(() => expect(within(session).getAllByRole('button', { name: 'Deny' })).toHaveLength(1));
      fireEvent.click(within(session).getByRole('button', { name: 'Deny' }));
      await waitFor(() => expect(transport.mock.calls.some(([url]) => String(url).endsWith('/fixture-deny/decision'))).toBe(true));
      expect(transport.mock.calls.filter(([url, options]) => String(url).endsWith('/commands') && JSON.parse(String(options?.body)).action === 'dispatch')).toHaveLength(0);
      fireEvent.change(within(session).getByLabelText('Message'), { target: { value: 'continue with fixture' } });
      fireEvent.click(within(session).getByRole('button', { name: 'Sign & send' }));
      await screen.findByText('Delivered · awaiting signed agent outcome');
      fireEvent.change(within(session).getByLabelText('Task'), { target: { value: 'prove child lineage' } });
      fireEvent.change(within(session).getByLabelText('Label'), { target: { value: 'fixture child' } });
      fireEvent.change(within(session).getByLabelText('Group'), { target: { value: 'fixture group' } });
      fireEvent.change(within(session).getByLabelText('Model'), { target: { value: 'fixture model' } });
      fireEvent.click(within(session).getByRole('button', { name: 'Sign & spawn' }));
      await waitFor(() => expect(transport.mock.calls.filter(([url, options]) => String(url).endsWith('/commands') && JSON.parse(String(options?.body)).action === 'dispatch')).toHaveLength(2));
      await waitFor(() => expect(within(session).queryByText('Preparing your signed wish…')).toBeNull());
      // Delivery does not await the fixture's asynchronously signed outcome.
      await vi.waitFor(() => expect(fixture.proofs).toHaveLength(4));
      await act(async () => { await vi.advanceTimersByTimeAsync(6000); });
      await waitFor(() => expect(screen.getAllByTestId('run-card')).toHaveLength(3));
      expect(await screen.findByText('Signed outcome: completed')).toBeDefined();
      await waitFor(() => expect(within(session).getAllByText('Approval resolved — agent attested')).toHaveLength(2));
      expect((within(session).getByLabelText('Message') as HTMLTextAreaElement).value).toBe('continue with fixture');
      expect(within(session).getByTestId('stored-output')).toBeDefined();
      expect(storage).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      fixture.dispose();
      storage.mockRestore();
    }
  });
});
