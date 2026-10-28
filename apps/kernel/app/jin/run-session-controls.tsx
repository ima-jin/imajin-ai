'use client';

import { useEffect, useRef, useState } from 'react';
import type { LoopEventJson } from '@/src/lib/loops/serialize';
import type { SessionCommandType } from '@/src/lib/jin/session-command-contract';
import { browserSessionCommands, type SessionCommandClient } from './session-command-client';
import { SessionCommandReceipt } from './run-composer';

export function RunSessionControls({ loopId, events, disabled, onDispatched, client = browserSessionCommands }: Readonly<{
  loopId: string; events: LoopEventJson[]; disabled: boolean; onDispatched: () => void; client?: SessionCommandClient;
}>) {
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [historyError, setHistoryError] = useState('');
  const [receipt, setReceipt] = useState<{ commandId: string; delivered: boolean } | null>(null);
  const requested = useRef(false);

  useEffect(() => {
    if (disabled || requested.current) return;
    let closed = false;
    void (async () => {
      await Promise.resolve();
      if (closed || requested.current) return;
      requested.current = true;
      try {
        const command = await client.prepare(loopId, 'session.history', { loopId });
        if (closed) return;
        const result = await client.dispatch(loopId, command);
        if (!closed) {
          if (!result.delivered) setHistoryError('Undelivered; no history refresh confirmed.');
          onDispatched();
        }
      } catch (cause) {
        if (!closed) setHistoryError(cause instanceof Error ? cause.message : 'History request unavailable.');
      }
    })();
    return () => { closed = true; };
  }, [loopId, disabled, client, onDispatched]);

  async function send(type: SessionCommandType) {
    setBusy(true);
    setError('');
    try {
      const payload = type === 'session.label' ? { loopId, label } : { loopId };
      const command = await client.prepare(loopId, type, payload);
      setReceipt(await client.dispatch(loopId, command));
      onDispatched();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Command unavailable. No execution confirmed.');
    } finally { setBusy(false); }
  }

  return <div className="min-w-0 space-y-2 border border-gray-700 p-3" data-testid="run-session-controls">
    <h4 className="text-sm text-gray-100">Session controls</h4>
    <label className="block">Session label
      <input aria-label="Session label" value={label} maxLength={256} onChange={event => setLabel(event.target.value)}
        className="block min-h-11 w-full min-w-0 bg-gray-900 p-2" />
    </label>
    <div className="flex flex-wrap gap-2">
      <button type="button" disabled={disabled || busy || !label.trim() || label.length > 256} className="min-h-11 px-3" onClick={() => void send('session.label')}>Sign & label</button>
      <button type="button" disabled={disabled || busy} className="min-h-11 px-3" onClick={() => void send('session.archive')}>Sign & archive</button>
      <button type="button" disabled={disabled || busy} className="min-h-11 px-3 text-red-300" onClick={() => void send('session.reset')}>Sign & reset</button>
    </div>
    <p>Archive hides the active row, never its history. Reset may be refused with missing_scope; no scopes are widened.</p>
    {busy && <output className="block">Preparing session wish…</output>}
    {receipt && <SessionCommandReceipt receipt={receipt} events={events} />}
    {error && <p role="alert" className="break-words text-red-300">{error}</p>}
    {historyError && <p className="break-words text-amber-300">History refresh: {historyError} Stored signed events remain below.</p>}
  </div>;
}
