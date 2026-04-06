'use client';

import { useState } from 'react';

// Serializable transaction — dates are ISO strings (serialized from server)
export type SerializedTx = {
  id: string;
  service: string;
  type: string;
  fromDid: string | null;
  toDid: string;
  amount: string;
  currency: string;
  status: string;
  source: string;
  stripeId: string | null;
  metadata: unknown;
  fairManifest: unknown;
  batchId: string | null;
  credentialIssued: boolean | null;
  createdAt: string | null;
};

export type DisplayEntry =
  | { kind: 'standalone'; tx: SerializedTx }
  | { kind: 'batch'; batchId: string; entries: SerializedTx[] };

interface TransactionListProps {
  displayEntries: DisplayEntry[];
  sessionId: string;
}

const SERVICE_ICONS: Record<string, string> = {
  coffee: '☕',
  events: '🎟',
  inference: '🤖',
  shop: '🛍',
  transfer: '↔',
  topup: '💳',
};

function fmt(amount: number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}

function fmtDate(iso: string | null) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'completed'
      ? 'bg-green-900/30 text-green-400 border-green-800'
      : status === 'failed'
        ? 'bg-red-900/30 text-red-400 border-red-800'
        : 'bg-zinc-800 text-zinc-400 border-zinc-700';
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full border ${cls}`}>{status}</span>
  );
}

function ChevronIcon() {
  return (
    <svg
      className="w-4 h-4 text-zinc-600 transition-transform group-open:rotate-180"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
    </svg>
  );
}

function StandaloneRow({ tx, sessionId }: { tx: SerializedTx; sessionId: string }) {
  const isIncoming = tx.toDid === sessionId;
  const amount = parseFloat(tx.amount);
  const icon = SERVICE_ICONS[tx.service] || '💳';
  const manifest = tx.fairManifest as {
    chain?: Array<{ did: string; amount: number; role: string }>;
  } | null;
  const hasChain = manifest?.chain && manifest.chain.length > 0;

  return (
    <details className="group">
      <summary className="px-5 py-4 flex items-center gap-4 cursor-pointer hover:bg-zinc-800/40 transition-colors [list-style:none] [&::-webkit-details-marker]:hidden">
        <span className="text-xl w-7 text-center shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-white capitalize">
              {tx.type.replace(/_/g, ' ')}
            </span>
            <span className="text-xs px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded-full text-zinc-400">
              {tx.service}
            </span>
            <StatusBadge status={tx.status} />
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">
            {fmtDate(tx.createdAt)}
            {tx.batchId && (
              <span className="ml-2 font-mono text-zinc-700">{tx.batchId.slice(0, 16)}</span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0 flex items-center gap-3">
          <div>
            <div
              className={`text-base font-semibold ${isIncoming ? 'text-green-400' : 'text-red-400'}`}
            >
              {isIncoming ? '+' : '-'}
              {fmt(amount, tx.currency)}
            </div>
            <div className="text-xs text-zinc-600">{tx.source}</div>
          </div>
          {(hasChain || !!tx.metadata) && <ChevronIcon />}
        </div>
      </summary>

      <div className="px-5 pb-5 pl-16 space-y-3 border-t border-zinc-800/60">
        <div className="pt-3 space-y-1.5">
          <div className="text-xs text-zinc-500">
            <span className="text-zinc-600 w-10 inline-block">From</span>
            <span className="font-mono text-zinc-400 break-all">{tx.fromDid || 'external'}</span>
          </div>
          <div className="text-xs text-zinc-500">
            <span className="text-zinc-600 w-10 inline-block">To</span>
            <span className="font-mono text-zinc-400 break-all">{tx.toDid}</span>
          </div>
        </div>

        {hasChain && (
          <div>
            <div className="text-xs font-medium text-zinc-400 mb-2">.fair attribution chain</div>
            <div className="space-y-1">
              {manifest!.chain!.map((entry, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 text-xs bg-black/40 border border-zinc-800 rounded-lg px-3 py-2"
                >
                  <span className="text-zinc-600 w-20 shrink-0">{entry.role}</span>
                  <span
                    className={`font-mono flex-1 truncate ${entry.did === sessionId ? 'text-orange-400' : 'text-zinc-400'}`}
                  >
                    {entry.did}
                  </span>
                  <span
                    className={`font-medium shrink-0 ${entry.did === sessionId ? 'text-orange-400' : 'text-zinc-300'}`}
                  >
                    {fmt(entry.amount, tx.currency)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {!!tx.metadata && Object.keys(tx.metadata as object).length > 0 && (
          <div>
            <div className="text-xs font-medium text-zinc-400 mb-2">Metadata</div>
            <pre className="text-xs font-mono bg-black/40 border border-zinc-800 rounded-lg p-3 text-zinc-500 overflow-auto whitespace-pre-wrap">
              {JSON.stringify(tx.metadata, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

function BatchGroupRow({
  entries,
  sessionId,
  showGross,
}: {
  entries: SerializedTx[];
  sessionId: string;
  showGross: boolean;
}) {
  const userEntry = entries.find((e) => e.toDid === sessionId) ?? entries[0];
  const icon = SERVICE_ICONS[userEntry.service] || '💳';

  const netAmount = parseFloat(userEntry.amount);

  // Prefer chain-based gross (includes parties not in user's query results)
  const manifest = userEntry.fairManifest as {
    chain?: Array<{ did: string; amount: number; role: string }>;
  } | null;
  const grossAmount =
    manifest?.chain && manifest.chain.length > 0
      ? manifest.chain.reduce((sum, e) => sum + e.amount, 0)
      : entries.reduce((sum, e) => sum + parseFloat(e.amount), 0);

  const displayAmount = showGross ? grossAmount : netAmount;
  const isIncoming = userEntry.toDid === sessionId;

  const earliestDate = entries.reduce<string | null>((min, e) => {
    if (!e.createdAt) return min;
    if (!min) return e.createdAt;
    return e.createdAt < min ? e.createdAt : min;
  }, null);

  const overallStatus = entries.every((e) => e.status === 'completed')
    ? 'completed'
    : entries.some((e) => e.status === 'failed')
      ? 'failed'
      : entries[0].status;

  return (
    <details className="group">
      <summary className="px-5 py-4 flex items-center gap-4 cursor-pointer hover:bg-zinc-800/40 transition-colors [list-style:none] [&::-webkit-details-marker]:hidden">
        <span className="text-xl w-7 text-center shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-white capitalize">
              {userEntry.type.replace(/_/g, ' ')}
            </span>
            <span className="text-xs px-2 py-0.5 bg-zinc-800 border border-zinc-700 rounded-full text-zinc-400">
              {userEntry.service}
            </span>
            <StatusBadge status={overallStatus} />
            {!showGross && grossAmount !== netAmount && (
              <span className="text-xs text-zinc-600">
                of {fmt(grossAmount, userEntry.currency)} gross
              </span>
            )}
          </div>
          <div className="text-xs text-zinc-500 mt-0.5">
            {fmtDate(earliestDate)}
            <span className="ml-2 font-mono text-zinc-700">{userEntry.batchId?.slice(0, 16)}</span>
          </div>
        </div>
        <div className="text-right shrink-0 flex items-center gap-3">
          <div>
            <div
              className={`text-base font-semibold ${isIncoming ? 'text-green-400' : 'text-red-400'}`}
            >
              {isIncoming ? '+' : '-'}
              {fmt(displayAmount, userEntry.currency)}
            </div>
            <div className="text-xs text-zinc-600">{userEntry.source}</div>
          </div>
          <ChevronIcon />
        </div>
      </summary>

      <div className="px-5 pb-5 pl-16 space-y-3 border-t border-zinc-800/60">
        {/* Settlement breakdown */}
        <div className="pt-3">
          <div className="text-xs font-medium text-zinc-400 mb-2">Settlement breakdown</div>
          <div className="space-y-1">
            {entries.map((e) => {
              const isUser = e.toDid === sessionId;
              return (
                <div
                  key={e.id}
                  className="flex items-center gap-3 text-xs bg-black/40 border border-zinc-800 rounded-lg px-3 py-2"
                >
                  <span className="text-zinc-600 w-24 shrink-0 capitalize">
                    {e.type.replace(/_/g, ' ')}
                  </span>
                  <span
                    className={`font-mono flex-1 truncate ${isUser ? 'text-orange-400' : 'text-zinc-400'}`}
                  >
                    {e.toDid}
                  </span>
                  <span
                    className={`font-medium shrink-0 ${isUser ? 'text-orange-400' : 'text-zinc-300'}`}
                  >
                    {fmt(parseFloat(e.amount), e.currency)}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="mt-2 flex justify-between text-xs px-3">
            <span className="text-zinc-500">Total</span>
            <span className="text-zinc-300 font-medium">{fmt(grossAmount, userEntry.currency)}</span>
          </div>
        </div>

        {!!userEntry.metadata && Object.keys(userEntry.metadata as object).length > 0 && (
          <div>
            <div className="text-xs font-medium text-zinc-400 mb-2">Metadata</div>
            <pre className="text-xs font-mono bg-black/40 border border-zinc-800 rounded-lg p-3 text-zinc-500 overflow-auto whitespace-pre-wrap">
              {JSON.stringify(userEntry.metadata, null, 2)}
            </pre>
          </div>
        )}
      </div>
    </details>
  );
}

export default function TransactionList({ displayEntries, sessionId }: TransactionListProps) {
  const [showGross, setShowGross] = useState(false);

  const hasBatched = displayEntries.some((e) => e.kind === 'batch');

  return (
    <div className="space-y-3">
      {hasBatched && (
        <div className="flex justify-end">
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-1">
            <button
              onClick={() => setShowGross(false)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                !showGross ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:text-zinc-300'
              }`}
            >
              Net
            </button>
            <button
              onClick={() => setShowGross(true)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                showGross ? 'bg-orange-500 text-white' : 'text-zinc-400 hover:text-zinc-300'
              }`}
            >
              Gross
            </button>
          </div>
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 rounded-xl divide-y divide-zinc-800">
        {displayEntries.map((entry) =>
          entry.kind === 'standalone' ? (
            <StandaloneRow key={entry.tx.id} tx={entry.tx} sessionId={sessionId} />
          ) : (
            <BatchGroupRow
              key={entry.batchId}
              entries={entry.entries}
              sessionId={sessionId}
              showGross={showGross}
            />
          ),
        )}
      </div>
    </div>
  );
}
