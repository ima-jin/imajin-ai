'use client';

import { useCallback, useEffect, useState } from 'react';
import type { LoopWithHistory, LoopsPage } from '@/src/lib/loops/query';
import { RunOutput } from './run-output';
import { RunComposer } from './run-composer';
import { RunBrief } from './run-brief';
import type { SessionCommandClient } from './session-command-client';
import { RunSessionControls } from './run-session-controls';


interface DetailProps {
  loopId: string;
  onSelect: (loopId: string) => void;
  onDenied: () => void;
  client?: SessionCommandClient;
}

export function RunsPanelDetail({ loopId, onSelect, onDenied, client }: Readonly<DetailProps>) {
  const [detail, setDetail] = useState<LoopWithHistory | null>(null);
  const [commandAvailable, setCommandAvailable] = useState(false);
  const [lineage, setLineage] = useState<LoopsPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const refreshDetail = useCallback(() => setRefresh((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    setError(null);
    async function load() {
      if (inFlight) return;
      inFlight = true;
      try {
        const responses = await Promise.all([
          fetch(`/jin/api/runs/${encodeURIComponent(loopId)}`, { credentials: 'include', signal: controller.signal }),
          fetch(`/jin/api/runs?ancestor=${encodeURIComponent(loopId)}`, { credentials: 'include', signal: controller.signal }),
        ]);
        if (controller.signal.aborted) return;
        if (responses.some((response) => response.status === 401 || response.status === 403)) {
          onDenied();
          return;
        }
        if (responses.some((response) => !response.ok)) throw new Error('History unavailable');
        const [history, tree] = await Promise.all(responses.map((response) => response.json()));
        if (controller.signal.aborted) return;
        if (!history.isOperator || !tree.isOperator) {
          onDenied();
          return;
        }
        setDetail(history.detail);
        setCommandAvailable(history.commandTarget?.available === true);
        setLineage(tree.page);
        setError(null);
      } catch {
        if (!controller.signal.aborted) {
          setCommandAvailable(false);
          setError('Run history unavailable. Try opening this run again.');
        }
      } finally {
        inFlight = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [loopId, onDenied, refresh]);

  useEffect(() => { setDetail(null); setLineage(null); setCommandAvailable(false); }, [loopId]);

  if (detail?.loop.loopId !== loopId) return error
    ? <p role="alert" className="text-sm text-red-300">{error}</p>
    : <output className="text-xs text-gray-400">Loading history…</output>;

  return (
    <div className="min-w-0 space-y-3 text-xs text-gray-400" data-testid="run-detail">
      <p className="break-all font-mono">{detail.loop.loopId}</p>
      {error && <p role="alert" className="text-red-300">{error}</p>}
      <dl className="space-y-1">
        {(['issue', 'pr'] as const).map((key) => typeof detail.loop.refs[key] === 'string' && (
          <div key={key} className="break-all"><dt className="inline text-gray-500">{key}: </dt><dd className="inline">{String(detail.loop.refs[key])}</dd></div>
        ))}
      </dl>
      <RunComposer key={loopId} loopId={loopId} events={detail.events} disabled={!commandAvailable || !!detail.loop.finishedAt} onDispatched={refreshDetail} client={client} />
      <RunSessionControls key={`session-${loopId}`} loopId={loopId} sessionName={detail.loop.summary} events={detail.events} disabled={!commandAvailable || !!detail.loop.finishedAt} onDispatched={refreshDetail} client={client} />
      <div>
        <h4 className="font-semibold text-gray-200">Lineage</h4>
        {detail.loop.parentLoopId && (
          <button type="button" className="block min-h-11 break-all text-left text-indigo-300" onClick={() => onSelect(detail.loop.parentLoopId!)}>
            Parent: {detail.loop.parentLoopId}
          </button>
        )}
        {!detail.loop.parentLoopId && <p className="mt-1">Root loop</p>}
        <ul>
          {lineage?.loops.filter((loop) => loop.loopId !== loopId).map((loop) => (
            <li key={loop.loopId}>
              <button type="button" className="min-h-11 break-all text-left text-indigo-300" onClick={() => onSelect(loop.loopId)}>
                {loop.summary} · {loop.kind} · {loop.state}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h4 className="font-semibold text-gray-200">History</h4>
        {detail.events.length === 0 && <p className="mt-1">No events recorded.</p>}
        <ol className="mt-2 space-y-2">
          {detail.events.map((event) => (
            <li key={event.id} className="break-words border-l border-gray-700 pl-3">
              <p className="text-gray-200">{event.type}</p>
              <time dateTime={event.occurredAt}>{event.occurredAt}</time>
              <p>{String(event.payload.summary ?? '')}</p>
              {event.type.startsWith('loop.session.') && <p className="break-all">
                Command: {String(event.payload.commandId ?? '')}
                {typeof event.payload.reason === 'string' && <span data-failure-reason={event.payload.reason}> · {event.payload.reason}</span>}
                {typeof event.payload.detail === 'string' && ` · ${event.payload.detail}`}
              </p>}
              <RunBrief value={event.payload.brief} />
              {event.payload.output && <RunOutput output={event.payload.output} />}
              <p className="break-all">Signed by {event.issuer}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
