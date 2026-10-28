// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RunSessionControls } from '../run-session-controls';
import type { SessionCommandClient } from '../session-command-client';
import type { LoopEventJson } from '@/src/lib/loops/serialize';
import type { SessionCommandFrame, SessionCommandType } from '@/src/lib/jin/session-command-contract';

afterEach(cleanup);
function setup(disabled = false) {
  const client = {
    prepare: vi.fn(async (_id: string, type: SessionCommandType) => ({ commandId: type })),
    dispatch: vi.fn(async (_id: string, command: SessionCommandFrame) => ({ commandId: command.commandId, delivered: true })),
  } as unknown as SessionCommandClient;
  const props = { loopId: 'loop', events: [] as LoopEventJson[], disabled, client, onDispatched: vi.fn() };
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
  it.each(['archive', 'label', 'reset'])('signs exact session.%s and only displays matching attested outcomes', async verb => {
    const { client, props, view } = setup();
    await waitFor(() => expect(client.dispatch).toHaveBeenCalledOnce());
    if (verb === 'label') fireEvent.change(screen.getByLabelText('Session label'), { target: { value: 'Operator label' } });
    fireEvent.click(screen.getByRole('button', { name: `Sign & ${verb}` }));
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
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Authorization changed');
    vi.mocked(client.prepare).mockReturnValueOnce(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Sign & reset' }));
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
