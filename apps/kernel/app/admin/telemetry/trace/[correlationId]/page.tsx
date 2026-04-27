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
          className="text-sm text-secondary dark:text-secondary hover:text-gray-700 dark:hover:text-primary mb-3 inline-block"
        >
          ← Telemetry
        </Link>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-primary font-mono">Trace</h1>
        <p className="mt-1 font-mono text-xs text-secondary dark:text-secondary break-all">
          {correlationId}
        </p>
      </div>

      {!data || data.steps.length === 0 ? (
        <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-8 text-center">
          <p className="text-secondary dark:text-secondary text-sm">
            No requests found for this correlation ID.
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10">
          <div className="px-5 py-4 border-b border-gray-100 dark:border-white/10 flex items-center justify-between">
            <span className="text-sm font-semibold text-gray-700 dark:text-primary">
              {data.steps.length} request{data.steps.length !== 1 ? 's' : ''}
            </span>
            {totalDuration !== null && (
              <span className="text-xs text-secondary dark:text-secondary">
                Total span: {totalDuration}ms
              </span>
            )}
          </div>

          <div className="divide-y divide-gray-50 dark:divide-white/10/50">
            {data.steps.map((step, i) => {
              const isError = step.status >= 400;
              return (
                <div key={step.id} className="px-5 py-4">
                  <div className="flex items-start gap-4">
                    {/* Step number */}
                    <div className="flex-shrink-0 w-6 h-6 bg-gray-100 dark:bg-surface-elevated flex items-center justify-center text-xs font-medium text-muted dark:text-secondary">
                      {i + 1}
                    </div>

                    <div className="flex-1 min-w-0">
                      {/* Main row */}
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-xs font-medium text-secondary dark:text-secondary uppercase tracking-wide">
                          {step.service}
                        </span>
                        <span className="font-mono text-xs text-secondary dark:text-secondary">
                          {step.method}
                        </span>
                        <span className="font-mono text-sm text-gray-900 dark:text-primary truncate">
                          {step.path}
                        </span>
                        <StatusBadge status={step.status} />
                        {step.duration_ms !== null && (
                          <span
                            className={`text-xs font-medium tabular-nums ml-auto ${
                              step.duration_ms >= 1000
                                ? 'text-error dark:text-error'
                                : step.duration_ms >= 500
                                ? 'text-warning dark:text-warning'
                                : 'text-secondary dark:text-secondary'
                            }`}
                          >
                            {step.duration_ms}ms
                          </span>
                        )}
                      </div>

                      {/* Meta row */}
                      <div className="mt-1 flex items-center gap-3 flex-wrap">
                        <span className="text-xs text-secondary dark:text-secondary tabular-nums">
                          {new Date(step.created_at).toISOString().replace('T', ' ').slice(0, 23)}
                        </span>
                        {step.did && (
                          <span className="font-mono text-xs text-secondary dark:text-secondary truncate max-w-[160px]">
                            {step.did.slice(0, 20)}…
                          </span>
                        )}
                        {step.ip && step.ip !== 'unknown' && (
                          <span className="text-xs text-secondary dark:text-secondary">{step.ip}</span>
                        )}
                      </div>

                      {/* Error message */}
                      {isError && step.error_message && (
                        <div className="mt-2 bg-error/10 dark:bg-error/20 px-3 py-2">
                          <p className="text-xs font-mono text-error dark:text-error break-all">
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
    ? 'bg-error/10 dark:bg-error/30 text-error dark:text-error'
    : isClientError
    ? 'bg-warning/10 dark:bg-warning/20 text-warning dark:text-warning'
    : 'bg-success/10 dark:bg-success/20 text-success dark:text-success';
  return (
    <span className={`inline-block px-1.5 py-0.5  text-xs font-mono font-medium ${cls}`}>
      {status}
    </span>
  );
}
