// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunSessionControls } from '../run-session-controls';
import type { SessionCommandClient } from '../session-command-client';
import type { LoopEventJson } from '@/src/lib/loops/serialize';
import type { SessionCommandFrame, SessionCommandType } from '@/src/lib/jin/session-command-contract';

afterEach(cleanup);
function setup(disabled = false, sessionName?: string) {
  const client = {
    prepare: vi.fn(async (_id: string, type: SessionCommandType) => ({ commandId: type })),
    dispatch: vi.fn(async (_id: string, command: SessionCommandFrame) => ({ commandId: command.commandId, delivered: true })),
  } as unknown as SessionCommandClient;
  const props = { loopId: 'loop', sessionName, events: [] as LoopEventJson[], disabled, client, onDispatched: vi.fn() };
  const view = render(<StrictMode><RunSessionControls {...props} /></StrictMode>);
  return { client, props, view };
}
describe('session lifecycle controls', () => {
  it('sends exactly one signed history wish on open, not on polling, and waits for verified availability', async () => {
    const { client, props, view } = setup(true);
    await act(async () => {});
    expect(client.prepare).not.toHaveBeenCalled();
    view.rerender(<StrictMode><RunSessionControls {...props} disabled={false} /></StrictMode>);
    await waitFor(() => expect(client.dispatch).toHaveBeenCalledOnce());
    expect(client.prepare).toHaveBeenCalledWith('loop', 'session.history', { loopId: 'loop' });
    expect(client.dispatch).toHaveBeenCalledWith('loop', { commandId: 'session.history' });
    view.rerender(<StrictMode><RunSessionControls {...props} disabled={false} events={[{} as LoopEventJson]} /></StrictMode>);
    expect(client.prepare).toHaveBeenCalledOnce();
  });
  it.each(['archive', 'reset'] as const)('%s requires a named explicit confirmation; Cancel sends no wish and double Confirm sends exactly once', async verb => {
    const sessionName = `Operator session ${'long-name-'.repeat(30)}`;
    const { client } = setup(false, sessionName);
    await waitFor(() => expect(client.dispatch).toHaveBeenCalledOnce());
    vi.mocked(client.prepare).mockClear();
    vi.mocked(client.dispatch).mockClear();
    const open = () => fireEvent.click(screen.getByRole('button', { name: `Sign & ${verb}` }));
    open();
    const panel = screen.getByRole('region', { name: `Confirm ${verb}` });
    expect(within(panel).getByRole('heading').textContent).toBe(`Confirm ${verb}: ${sessionName}`);
    expect(panel.textContent).toContain('record');
    expect(panel.textContent).toContain('kept');
    if (verb === 'archive') {
      expect(panel.textContent).toContain('leaves active Threads');
      expect(panel.textContent).toContain('history and record are kept');
      expect(panel.textContent).toContain('cannot be undone from /jin');
    } else {
      expect(panel.textContent).toContain('live context is wiped and it starts fresh');
      expect(panel.textContent).toContain('currently fails with missing_scope until the plugin supports reset');
      expect(within(panel).getByRole('link', { name: 'Plugin reset support tracker' }).getAttribute('href'))
        .toBe('https://github.com/ima-jin/openclaw-imajin-plugin/issues/115');
    }
    expect(panel.className).toContain('min-w-0');
    expect(within(panel).getByRole('heading').className).toContain('break-words');
    const cancel = within(panel).getByRole('button', { name: 'Cancel' });
    const confirm = within(panel).getByRole('button', { name: `Confirm ${verb}` });
    for (const button of [cancel, confirm]) expect(button.className).toContain('min-h-11');
    expect(cancel.parentElement?.className).toContain('flex-col');
    expect(cancel.parentElement?.className).toContain('gap-3');
    expect(confirm.className).toContain('bg-red-700');
    expect(cancel.className).not.toContain('bg-red-700');
    expect(client.prepare).not.toHaveBeenCalled();
    expect(client.dispatch).not.toHaveBeenCalled();
    fireEvent.click(cancel);
    expect(screen.queryByRole('region', { name: `Confirm ${verb}` })).toBeNull();
    expect(client.prepare).not.toHaveBeenCalled();
    expect(client.dispatch).not.toHaveBeenCalled();

    let finishPrepare!: (command: SessionCommandFrame) => void;
    vi.mocked(client.prepare).mockReturnValueOnce(new Promise(resolve => { finishPrepare = resolve; }));
    open();
    const confirmed = screen.getByRole('button', { name: `Confirm ${verb}` });
    act(() => { fireEvent.click(confirmed); fireEvent.click(confirmed); });
    expect(screen.queryByRole('region', { name: `Confirm ${verb}` })).toBeNull();
    expect(client.prepare).toHaveBeenCalledOnce();
    expect(client.prepare).toHaveBeenCalledWith('loop', `session.${verb}`, { loopId: 'loop' });
    expect(client.dispatch).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: `Sign & ${verb}` }).hasAttribute('disabled')).toBe(true);
    await act(async () => { finishPrepare({ commandId: `session.${verb}` } as SessionCommandFrame); });
    expect(client.dispatch).toHaveBeenCalledOnce();
    expect(client.dispatch).toHaveBeenCalledWith('loop', { commandId: `session.${verb}` });
  });
  it.each([undefined, '   ', 'Session summary'])('uses the current session summary/id fallback for name=%s, never the unsubmitted label draft', async sessionName => {
    setup(false, sessionName);
    await screen.findByTestId('run-session-controls');
    fireEvent.change(screen.getByLabelText('Session label'), { target: { value: 'Unsubmitted draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign & archive' }));
    expect(screen.getByRole('heading', { name: `Confirm archive: ${sessionName?.trim() || 'loop'}` })).toBeDefined();
    expect(screen.getByRole('region', { name: 'Confirm archive' }).textContent).not.toContain('Unsubmitted draft');
  });
  it.each(['archive', 'reset'] as const)('refuses confirmation of %s if command availability is revoked', async verb => {
    const { client, props, view } = setup();
    await waitFor(() => expect(client.dispatch).toHaveBeenCalledOnce());
    vi.mocked(client.prepare).mockClear();
    vi.mocked(client.dispatch).mockClear();
    fireEvent.click(screen.getByRole('button', { name: `Sign & ${verb}` }));
    view.rerender(<StrictMode><RunSessionControls {...props} disabled /></StrictMode>);
    const confirm = screen.getByRole('button', { name: `Confirm ${verb}` });
    expect(confirm.hasAttribute('disabled')).toBe(true);
    fireEvent.click(confirm);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(client.prepare).not.toHaveBeenCalled();
    expect(client.dispatch).not.toHaveBeenCalled();
  });
  it.each(['archive', 'label', 'reset'])('signs exact session.%s and only displays matching attested outcomes', async verb => {
    const { client, props, view } = setup();
    await waitFor(() => expect(client.dispatch).toHaveBeenCalledOnce());
    if (verb === 'label') fireEvent.change(screen.getByLabelText('Session label'), { target: { value: 'Operator label' } });
    fireEvent.click(screen.getByRole('button', { name: `Sign & ${verb}` }));
    if (verb !== 'label') fireEvent.click(screen.getByRole('button', { name: `Confirm ${verb}` }));
    expect(screen.queryByRole('region', { name: /Confirm/ })).toBeNull();
    await screen.findByText('Delivered · awaiting signed agent outcome');
    expect(client.prepare).toHaveBeenLastCalledWith('loop', `session.${verb}`, { loopId: 'loop', ...(verb === 'label' ? { label: 'Operator label' } : {}) });
    const result = { id: 'result', type: `loop.session.${verb}.failed`, payload: { commandId: `session.${verb}`, reason: 'missing_scope' } } as unknown as LoopEventJson;
    view.rerender(<StrictMode><RunSessionControls {...props} events={[{ ...result, payload: { commandId: 'foreign' } }]} /></StrictMode>);
    expect(screen.queryByText('Signed outcome: failed · missing_scope')).toBeNull();
    view.rerender(<StrictMode><RunSessionControls {...props} events={[result]} /></StrictMode>);
    expect(screen.getByText('Signed outcome: failed · missing_scope').getAttribute('data-failure-reason')).toBe('missing_scope');
    expect(screen.queryByText('Signed outcome: completed')).toBeNull();
  });
  it('disables blank/long labels, unavailable and busy controls and preserves command failure', async () => {
    const { client } = setup();
    await waitFor(() => expect(client.dispatch).toHaveBeenCalledOnce());
    const label = screen.getByRole('button', { name: 'Sign & label' });
    expect(label.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Session label'), { target: { value: ' \t' } });
    expect(label.hasAttribute('disabled')).toBe(true);
    fireEvent.change(screen.getByLabelText('Session label'), { target: { value: 'x'.repeat(257) } });
    expect(label.hasAttribute('disabled')).toBe(true);
    vi.mocked(client.prepare).mockRejectedValueOnce(new Error('Authorization changed'));
    fireEvent.click(screen.getByRole('button', { name: 'Sign & archive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm archive' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Authorization changed');
    vi.mocked(client.prepare).mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Sign & reset' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm reset' }));
    await screen.findByText('Preparing session wish…');
    for (const button of screen.getAllByRole('button')) {
      expect(button.hasAttribute('disabled')).toBe(true);
      expect(button.className).toContain('min-h-11');
    }
  });
  it('retains stored events when a history wish cannot be signed', async () => {
    const { client, props, view } = setup(true);
    vi.mocked(client.prepare).mockRejectedValueOnce(new Error('Signing key unavailable'));
    view.rerender(<StrictMode><RunSessionControls {...props} disabled={false} /></StrictMode>);
    expect(await screen.findByText(/Signing key unavailable/)).toHaveProperty('textContent', 'History refresh: Signing key unavailable Stored signed events remain below.');
    expect(client.dispatch).not.toHaveBeenCalled();
  });
});
