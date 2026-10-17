'use client';

import { useEffect, useState } from 'react';
import type { LoopWithHistory, LoopsPage } from '@/src/lib/loops/query';

interface DetailProps {
  loopId: string;
  onSelect: (loopId: string) => void;
  onDenied: () => void;
}

export function RunsPanelDetail({ loopId, onSelect, onDenied }: Readonly<DetailProps>) {
  const [detail, setDetail] = useState<LoopWithHistory | null>(null);
  const [lineage, setLineage] = useState<LoopsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setLineage(null);
    setError(null);
    async function load() {
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
        setLineage(tree.page);
      } catch {
        if (!controller.signal.aborted) setError('Run history unavailable. Try opening this run again.');
      }
    }
    void load();
    return () => controller.abort();
  }, [loopId, onDenied]);

  if (error) return <p role="alert" className="text-sm text-red-300">{error}</p>;
  if (!detail) return <output className="text-xs text-gray-400">Loading history…</output>;

  return (
    <div className="min-w-0 space-y-3 text-xs text-gray-400" data-testid="run-detail">
      <p className="break-all font-mono">{detail.loop.loopId}</p>
      <dl className="space-y-1">
        {Object.entries(detail.loop.refs).map(([key, value]) => (
          <div key={key} className="break-all"><dt className="inline text-gray-500">{key}: </dt><dd className="inline">{String(value)}</dd></div>
        ))}
      </dl>
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
              <p className="break-all">Signed by {event.issuer}</p>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
