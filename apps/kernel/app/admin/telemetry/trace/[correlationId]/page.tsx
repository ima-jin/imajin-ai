import { getSession } from '@imajin/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';

interface TraceStep {
  id: string;
  service: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number | null;
  did: string | null;
  ip: string | null;
  correlation_id: string;
  error_message: string | null;
  created_at: string;
}

async function fetchTrace(correlationId: string): Promise<{ steps: TraceStep[] } | null> {
  const port = process.env.PORT ?? '7000';
  try {
    const res = await fetch(
      `http://localhost:${port}/api/admin/telemetry/trace/${encodeURIComponent(correlationId)}`,
      { cache: 'no-store' }
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function TracePage({
  params,
}: {
  params: { correlationId: string };
}) {
  const session = await getSession();
  if (!session?.actingAs) redirect('/');

  const { correlationId } = params;
  const data = await fetchTrace(correlationId);

  const totalDuration =
    data && data.steps.length >= 2
      ? new Date(data.steps[data.steps.length - 1].created_at).getTime() -
        new Date(data.steps[0].created_at).getTime()
      : null;

  return (
    <div className="p-6 lg:p-8 max-w-5xl">
      <div className="mb-6">
        <Link
          href="/admin/telemetry"
          className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mb-3 inline-block"
        >
          ← Telemetry
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Trace</h1>
        <p className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400 break-all">
          {correlationId}
        </p>
      </div>

      {!data || data.steps.length === 0 ? (
        <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700 p-8 text-center">
          <p className="text-gray-500 dark:text-gray-400 text-sm">
            No requests found for this correlation ID.
          </p>
        </div>
      ) : (
        <div className="rounded-xl bg-white dark:bg-gray-800 shadow border border-gray-100 dark:border-gray-700">
          <div className="px-5 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">
              {data.steps.length} request{data.steps.length !== 1 ? 's' : ''}
            </span>
            {totalDuration !== null && (
              <span className="text-xs text-gray-500 dark:text-gray-400">
                Total span: {totalDuration}ms
              </span>
            )}
          </div>

          <div className="divide-y divide-gray-50 dark:divide-gray-700/50">
            {data.steps.map((step, i) => {
              const isError = step.status >= 400;
              return (
                <div key={step.id} className="px-5 py-4">
                  <div className="flex items-start gap-4">
                    {/* Step number */}
                    <div className="flex-shrink-0 w-6 h-6 rounded-full bg-gray-100 dark:bg-gray-700 flex items-center justify-center text-xs font-medium text-gray-600 dark:text-gray-400">
                      {i + 1}
                    </div>

                    <div className="flex-1 min-w-0">
                      {/* Main row */}
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wide">
                          {step.service}
                        </span>
                        <span className="font-mono text-xs text-gray-400 dark:text-gray-500">
                          {step.method}
                        </span>
                        <span className="font-mono text-sm text-gray-900 dark:text-gray-100 truncate">
                          {step.path}
                        </span>
                        <StatusBadge status={step.status} />
                        {step.duration_ms !== null && (
                          <span
                            className={`text-xs font-medium tabular-nums ml-auto ${
                              step.duration_ms >= 1000
                                ? 'text-red-600 dark:text-red-400'
                                : step.duration_ms >= 500
                                ? 'text-amber-600 dark:text-amber-400'
                                : 'text-gray-500 dark:text-gray-400'
                            }`}
                          >
                            {step.duration_ms}ms
                          </span>
                        )}
                      </div>

                      {/* Meta row */}
                      <div className="mt-1 flex items-center gap-3 flex-wrap">
                        <span className="text-xs text-gray-400 dark:text-gray-500 tabular-nums">
                          {new Date(step.created_at).toISOString().replace('T', ' ').slice(0, 23)}
                        </span>
                        {step.did && (
                          <span className="font-mono text-xs text-gray-400 dark:text-gray-500 truncate max-w-[160px]">
                            {step.did.slice(0, 20)}…
                          </span>
                        )}
                        {step.ip && step.ip !== 'unknown' && (
                          <span className="text-xs text-gray-400 dark:text-gray-500">{step.ip}</span>
                        )}
                      </div>

                      {/* Error message */}
                      {isError && step.error_message && (
                        <div className="mt-2 rounded bg-red-50 dark:bg-red-900/20 px-3 py-2">
                          <p className="text-xs font-mono text-red-700 dark:text-red-400 break-all">
                            {step.error_message}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: number }) {
  const isError = status >= 500;
  const isClientError = status >= 400 && status < 500;
  const cls = isError
    ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400'
    : isClientError
    ? 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400'
    : 'bg-green-100 dark:bg-green-900/20 text-green-700 dark:text-green-400';
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-mono font-medium ${cls}`}>
      {status}
    </span>
  );
}
