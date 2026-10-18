// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoopEventJson } from '@/src/lib/loops/serialize';
import { RunComposer, commandOutcome, storedCommandReceipt } from '../run-composer';
import { prepareSignedSessionCommand, dispatchSessionCommand } from '../session-command-client';

vi.mock('../session-command-client', () => ({
  prepareSignedSessionCommand: vi.fn(), dispatchSessionCommand: vi.fn(),
  get browserSessionCommands() { return { prepare: this.prepareSignedSessionCommand, dispatch: this.dispatchSessionCommand }; },
}));
const prepare = vi.mocked(prepareSignedSessionCommand);
const dispatch = vi.mocked(dispatchSessionCommand);
const event = (id = 'command-1', type = 'loop.session.send.completed') => ({
  id: 'event', type, payload: { commandId: id },
}) as unknown as LoopEventJson;

beforeEach(() => {
  prepare.mockResolvedValue({ commandId: 'command-1' } as Awaited<ReturnType<typeof prepare>>);
  dispatch.mockResolvedValue({ commandId: 'command-1', delivered: true });
});
afterEach(() => { cleanup(); vi.resetAllMocks(); });

describe('RunComposer', () => {
  it('signs loop-addressed send, awaits only correlated outcome and preserves its draft', async () => {
    const refreshed = vi.fn();
    const view = render(<RunComposer loopId="loop" events={[]} onDispatched={refreshed} />);
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'continue please' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign & send' }));
    await screen.findByText('Delivered · awaiting signed agent outcome');
    expect(prepare).toHaveBeenCalledWith('loop', 'session.send', { loopId: 'loop', message: 'continue please' });
    expect(refreshed).toHaveBeenCalledOnce();
    view.rerender(<RunComposer loopId="loop" events={[event('foreign')]} onDispatched={refreshed} />);
    expect(screen.getByText('Delivered · awaiting signed agent outcome')).toBeDefined();
    view.rerender(<RunComposer loopId="loop" events={[event()]} onDispatched={refreshed} />);
    expect(screen.getByText('Signed outcome: completed')).toBeDefined();
    expect((screen.getByLabelText('Message') as HTMLTextAreaElement).value).toBe('continue please');
  });

  it('signs stop and renders undelivered rather than completion', async () => {
    dispatch.mockResolvedValue({ commandId: 'command-1', delivered: false });
    render(<RunComposer loopId="loop" events={[]} onDispatched={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign & stop' }));
    expect(await screen.findByText('Undelivered · no execution confirmed')).toBeDefined();
    expect(prepare).toHaveBeenCalledWith('loop', 'session.abort', { loopId: 'loop' });
  });

  it.each([true, false])('signs spawn with optional fields=%s', async (optional) => {
    render(<RunComposer loopId="loop" events={[]} onDispatched={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Task'), { target: { value: 'test child' } });
    if (optional) for (const name of ['Label', 'Group', 'Model']) {
      fireEvent.change(screen.getByLabelText(name), { target: { value: name.toLowerCase() } });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Sign & spawn' }));
    await waitFor(() => expect(dispatch).toHaveBeenCalled());
    expect(prepare).toHaveBeenCalledWith('loop', 'session.spawn', {
      parentLoopId: 'loop', task: 'test child', ...(optional ? { label: 'label', group: 'group', model: 'model' } : {}),
    });
  });

  it('shows failed attestation, missing keys and generic rejection without clearing text', async () => {
    prepare.mockRejectedValueOnce(new Error('A signing key is required in this browser.'));
    const view = render(<RunComposer loopId="loop" events={[]} onDispatched={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Sign & stop' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'A signing key is required in this browser.');
    fireEvent.click(screen.getByRole('button', { name: 'Sign & stop' }));
    await screen.findByText('Delivered · awaiting signed agent outcome');
    view.rerender(<RunComposer loopId="loop" events={[event('command-1', 'loop.session.abort.failed')]} onDispatched={vi.fn()} />);
    expect(screen.getByText('Signed outcome: failed')).toBeDefined();
    prepare.mockRejectedValueOnce(null);
    fireEvent.click(screen.getByRole('button', { name: 'Sign & stop' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Command unavailable. No execution confirmed.');
  });

  it('disables unavailable destinations and in-flight requests; all controls have phone targets', async () => {
    const view = render(<RunComposer loopId="loop" events={[]} disabled onDispatched={vi.fn()} />);
    expect(screen.getByText(/no verified serving agent/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Sign & stop' }).hasAttribute('disabled')).toBe(true);
    view.rerender(<RunComposer loopId="loop" events={[]} onDispatched={vi.fn()} />);
    prepare.mockReturnValue(new Promise(() => {}));
    fireEvent.click(screen.getByRole('button', { name: 'Sign & stop' }));
    expect(await screen.findByText('Preparing your signed wish…')).toBeDefined();
    for (const button of screen.getAllByRole('button')) expect(button.className).toContain('min-h-11');
    expect(screen.getByRole('button', { name: 'Sign & stop' }).hasAttribute('disabled')).toBe(true);
  });

  it('ignores delivery, lifecycle and unrelated command events', () => {
    expect(commandOutcome('command-1', [event('command-1', 'session.command.requested')])).toBeNull();
    expect(commandOutcome('command-1', [event('other')])).toBeNull();
  });

  it('recovers recorded/delivered receipts from history after reload', () => {
    const queued = event('command-1', 'loop.command.queued');
    const transport = { ...event('command-1', 'loop.command.transport'), payload: { commandId: 'command-1', delivered: false } };
    expect(storedCommandReceipt([queued, transport])).toEqual({ commandId: 'command-1', delivered: false });
    const view = render(<RunComposer loopId="loop" events={[queued]} onDispatched={vi.fn()} />);
    expect(screen.getByText(/Recorded · awaiting transport confirmation/)).toBeDefined();
    view.rerender(<RunComposer loopId="loop" events={[queued, { ...transport, payload: { ...transport.payload, delivered: true } }]} onDispatched={vi.fn()} />);
    expect(screen.getByText('Delivered · awaiting signed agent outcome')).toBeDefined();
    view.rerender(<RunComposer loopId="loop" events={[queued, transport, event()]} onDispatched={vi.fn()} />);
    expect(screen.getByText('Signed outcome: completed')).toBeDefined();
  });
});
