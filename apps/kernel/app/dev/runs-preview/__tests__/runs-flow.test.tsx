// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunsPanel } from '@/app/jin/runs-panel';
import { dispatchSessionCommand, prepareSignedSessionCommand, type SessionCommandClient } from '@/app/jin/session-command-client';
import { createRunsPreviewTransport } from '../transport';
import { loadOperatorSigner } from '@/app/jin/__tests__/operator-signing-test-support';

vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

async function createFlowFixture() {
  const pending: (() => Promise<void>)[] = [];
  const fixture = await createRunsPreviewTransport('active', undefined, complete => pending.push(complete));
  return {
    ...fixture,
    async completeOutcomes(count: number) {
      // Wait for dispatch/signing, not wall-clock agent latency. Delivery and
      // execution remain separate, and every outcome is really signed/verified.
      await vi.waitFor(() => expect(pending.length + fixture.proofs.length).toBe(count));
      await act(async () => { await Promise.all(pending.splice(0).map(complete => complete())); });
      expect(fixture.proofs).toHaveLength(count);
    },
  };
}
beforeEach(async () => {
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
  vi.stubEnv('NODE_ENV', 'development');
  await loadOperatorSigner();
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
  // This flow performs several real signature round trips; coverage on a busy CI
  // runner can exceed Vitest's 5s default without any simulated agent latency.
  vi.setConfig({ testTimeout: 15_000 });
  it('signs send/spawn and inline native approve/deny through the shared endpoint, then displays attested results', async () => {
    // Only polling is virtual; outcomes are released explicitly after delivery.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    const fixture = await createFlowFixture();
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
      expect(transport.mock.calls.filter(([url, options]) => String(url).endsWith('/commands') && JSON.parse(String(options?.body)).action === 'dispatch')).toHaveLength(1);
      fireEvent.change(within(session).getByLabelText('Message'), { target: { value: 'continue with fixture' } });
      fireEvent.click(within(session).getByRole('button', { name: 'Sign & send' }));
      await screen.findByText('Delivered · awaiting signed agent outcome');
      fireEvent.change(within(session).getByLabelText('Task'), { target: { value: 'prove child lineage' } });
      fireEvent.change(within(session).getByLabelText('Label'), { target: { value: 'fixture child' } });
      fireEvent.change(within(session).getByLabelText('Group'), { target: { value: 'fixture group' } });
      fireEvent.change(within(session).getByLabelText('Model'), { target: { value: 'fixture model' } });
      fireEvent.click(within(session).getByRole('button', { name: 'Sign & spawn' }));
      await waitFor(() => expect(transport.mock.calls.filter(([url, options]) => String(url).endsWith('/commands') && JSON.parse(String(options?.body)).action === 'dispatch')).toHaveLength(3));
      await waitFor(() => expect(within(session).queryByText('Preparing your signed wish…')).toBeNull());
      // Delivery does not await the fixture's asynchronously signed outcome.
      expect(fixture.proofs).toHaveLength(0);
      await fixture.completeOutcomes(5);
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
  it('labels, shows signed reset scope denial, archives only after outcome and keeps typed history', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const fixture = await createFlowFixture();
    const client: SessionCommandClient = {
      prepare: (loopId, type, payload) => prepareSignedSessionCommand(loopId, type, payload, fixture.keypair),
      dispatch: dispatchSessionCommand,
    };
    const transport = vi.fn(fixture.fetcher);
    vi.stubGlobal('fetch', transport);
    const view = render(<RunsPanel client={client} />);
    try {
      const session = (await screen.findAllByTestId('run-card')).find(card => card.textContent?.includes('openclaw.session'))!;
      fireEvent.click(within(session).getByRole('button', { expanded: false }));
      await screen.findByTestId('run-session-controls');
      await fixture.completeOutcomes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(await screen.findByText('Recent redacted history from signed session.history')).toBeDefined();
      fireEvent.change(screen.getByLabelText('Session label'), { target: { value: 'Operator-labelled session' } });
      fireEvent.click(screen.getByRole('button', { name: 'Sign & label' }));
      await screen.findByText('Delivered · awaiting signed agent outcome');
      expect(within(session).queryByText('Operator-labelled session')).toBeNull();
      await fixture.completeOutcomes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(await within(session).findByText('Operator-labelled session')).toBeDefined();
      fireEvent.click(screen.getByRole('button', { name: 'Sign & reset' }));
      expect(screen.getByRole('heading', { name: 'Confirm reset: Operator-labelled session' })).toBeDefined();
      expect(fixture.proofs).toHaveLength(2);
      fireEvent.click(screen.getByRole('button', { name: 'Confirm reset' }));
      await fixture.completeOutcomes(3);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(await screen.findByText('Signed outcome: failed · missing_scope')).toBeDefined();
      expect(screen.getByText('loop.session.reset.failed')).toBeDefined();
      fireEvent.click(screen.getByRole('button', { name: 'Sign & archive' }));
      expect(screen.getByRole('heading', { name: 'Confirm archive: Operator-labelled session' })).toBeDefined();
      expect(fixture.proofs).toHaveLength(3);
      fireEvent.click(screen.getByRole('button', { name: 'Confirm archive' }));
      await screen.findByText('Delivered · awaiting signed agent outcome');
      expect(screen.getAllByTestId('run-card')).toHaveLength(2);
      await fixture.completeOutcomes(4);
      await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
      expect(screen.getAllByTestId('run-card')).toHaveLength(1);
      expect(await screen.findByRole('button', { name: 'Close run history' })).toBeDefined();
      expect(screen.getByText('Recent redacted history from signed session.history')).toBeDefined();
      expect(screen.getByText('loop.session.archive.completed')).toBeDefined();
      expect(screen.getByText('Tool call · inspect · history-call')).toBeDefined();
      expect(screen.getByText('Tool result · history-call')).toBeDefined();
      fireEvent.click(screen.getByRole('button', { name: 'Close run history' }));
      expect(screen.queryByTestId('run-detail')).toBeNull();
      fireEvent.click(screen.getByText('Operator-labelled session · archived history'));
      expect(await screen.findByText('Recent redacted history from signed session.history')).toBeDefined();
      const wishes = transport.mock.calls.flatMap(([url, options]) => {
        if (!String(url).endsWith('/commands')) return [];
        const body = JSON.parse(String(options?.body));
        return body.action === 'dispatch' ? [body.command] : [];
      });
      expect(wishes.map(command => command.type)).toEqual(['session.history', 'session.label', 'session.reset', 'session.archive']);
      expect(wishes.every(command => !!command.signature && !!command.countersignature)).toBe(true);
    } finally { view.unmount(); fixture.dispose(); }
  });
});
