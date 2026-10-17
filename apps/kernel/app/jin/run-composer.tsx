'use client';

import { useState } from 'react';
import type { LoopEventJson } from '@/src/lib/loops/serialize';
import type { SessionCommandType } from '@/src/lib/jin/session-command-contract';
import { browserSessionCommands, type SessionCommandClient } from './session-command-client';

export function commandOutcome(commandId: string, events: LoopEventJson[]): 'completed' | 'failed' | null {
  const event = events.find((entry) => entry.payload.commandId === commandId
    && /^loop\.session\.[a-z]+\.(completed|failed)$/.test(entry.type));
  if (!event) return null;
  return event.type.endsWith('.completed') ? 'completed' : 'failed';
}

export function storedCommandReceipt(events: LoopEventJson[]): { commandId: string; delivered: boolean | null } | null {
  const queued = events.filter((event) => event.type === 'loop.command.queued' && typeof event.payload.commandId === 'string').at(-1);
  if (!queued) return null;
  const commandId = queued.payload.commandId as string;
  const transport = events.filter((event) => event.type === 'loop.command.transport' && event.payload.commandId === commandId).at(-1);
  return { commandId, delivered: typeof transport?.payload.delivered === 'boolean' ? transport.payload.delivered : null };
}

function receiptLabel(receipt: { delivered: boolean | null }, outcome: 'completed' | 'failed' | null): string {
  if (outcome) return `Signed outcome: ${outcome}`;
  if (receipt.delivered === null) return 'Recorded · awaiting transport confirmation; no execution confirmed';
  return receipt.delivered ? 'Delivered · awaiting signed agent outcome' : 'Undelivered · no execution confirmed';
}

export function RunComposer({ loopId, events, disabled, onDispatched, client = browserSessionCommands }: Readonly<{
  loopId: string; events: LoopEventJson[]; disabled?: boolean; onDispatched: () => void; client?: SessionCommandClient;
}>) {
  const [message, setMessage] = useState('');
  const [task, setTask] = useState('');
  const [label, setLabel] = useState('');
  const [group, setGroup] = useState('');
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<{ commandId: string; delivered: boolean } | null>(null);
  const [error, setError] = useState('');
  const currentReceipt = receipt ?? storedCommandReceipt(events);
  const outcome = currentReceipt ? commandOutcome(currentReceipt.commandId, events) : null;
  async function send(type: SessionCommandType, payload: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const command = await client.prepare(loopId, type, payload);
      setReceipt(await client.dispatch(loopId, command));
      onDispatched();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Command unavailable. No execution confirmed.');
    } finally { setBusy(false); }
  }
  const locked = disabled || busy;
  return <div className="min-w-0 space-y-3 rounded border border-gray-700 p-3" data-testid="run-composer">
    <h4 className="text-sm text-gray-100">Drive this thread</h4>
    {disabled && <p>Commands unavailable: no verified serving agent or the loop has ended.</p>}
    <label className="block">Message
      <textarea aria-label="Message" value={message} onChange={(event) => setMessage(event.target.value)} className="block min-h-11 w-full min-w-0 rounded bg-gray-900 p-2" />
    </label>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={locked || !message.trim()} className="min-h-11 px-3" onClick={() => void send('session.send', { loopId, message })}>Sign & send</button>
      <button type="button" disabled={locked} className="min-h-11 px-3 text-red-300" onClick={() => void send('session.abort', { loopId })}>Sign & stop</button>
    </div>
    <details><summary className="min-h-11 cursor-pointer py-3">Spawn child task</summary>
      <div className="min-w-0 space-y-2">
        <label className="block">Task<textarea aria-label="Task" value={task} onChange={(event) => setTask(event.target.value)} className="block min-h-11 w-full min-w-0 rounded bg-gray-900 p-2" /></label>
        {[{ name: 'Label', value: label, set: setLabel }, { name: 'Group', value: group, set: setGroup }, { name: 'Model', value: model, set: setModel }].map((field) =>
          <label key={field.name} className="block">{field.name}<input aria-label={field.name} value={field.value} onChange={(event) => field.set(event.target.value)} className="block min-h-11 w-full min-w-0 rounded bg-gray-900 p-2" /></label>)}
        <button type="button" disabled={locked || !task.trim()} className="min-h-11 px-3" onClick={() => void send('session.spawn', {
          parentLoopId: loopId, task, ...(label ? { label } : {}), ...(group ? { group } : {}), ...(model ? { model } : {}),
        })}>Sign & spawn</button>
      </div>
    </details>
    {busy && <p role="status">Preparing your signed wish…</p>}
    {currentReceipt && <p role="status">{receiptLabel(currentReceipt, outcome)}</p>}
    {error && <p role="alert" className="break-words text-red-300">{error}</p>}
  </div>;
}
