import { getSession } from '@imajin/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';

interface VolumeRow {
  hour: string;
  count: number;
}

interface LatencyRow {
  path: string;
  method: string;
  total_requests: number;
  p50: number;
  p95: number;
  p99: number;
}

interface ErrorRateRow {
  path: string;
  method: string;
  total_requests: number;
  error_count: number;
  error_rate: string;
}

interface SlowestRow {
  path: string;
  method: string;
  total_requests: number;
  p95: number;
  max_ms: number;
}

interface RecentError {
  id: string;
  service: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number | null;
  correlation_id: string | null;
  error_message: string | null;
  created_at: string;
}

interface TelemetryData {
  volume: VolumeRow[];
  latency: LatencyRow[];
  errorRates: ErrorRateRow[];
  slowest: SlowestRow[];
}

interface ErrorsData {
  rows: RecentError[];
  total: number;
}

async function fetchTelemetry(): Promise<TelemetryData | null> {
  const port = process.env.PORT ?? '7000';
  try {
    const res = await fetch(`http://localhost:${port}/api/admin/telemetry`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchRecentErrors(): Promise<ErrorsData | null> {
  const port = process.env.PORT ?? '7000';
  try {
    const res = await fetch(
      `http://localhost:${port}/api/admin/telemetry/errors?limit=10`,
      { cache: 'no-store' }
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

export default async function TelemetryPage() {
  const session = await getSession();
  if (!session?.actingAs) redirect('/');

  const [data, errorsData] = await Promise.all([fetchTelemetry(), fetchRecentErrors()]);

  return (
    <div className="p-6 lg:p-8 max-w-7xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-primary font-mono">Telemetry</h1>
        <p className="mt-1 text-sm text-secondary dark:text-secondary">
          Request logs, latency percentiles, and error rates (last 24h)
        </p>
      </div>

      {!data ? (
        <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-8 text-center">
          <p className="text-secondary dark:text-secondary text-sm">
            No telemetry data. Set <code className="font-mono bg-gray-100 dark:bg-surface-elevated px-1 ">ENABLE_REQUEST_LOG=true</code> to start collecting.
          </p>
        </div>
      ) : (
        <div className="space-y-8">
          {/* Request Volume Chart */}
          <Section title="Request Volume (24h)">
            <VolumeChart rows={data.volume} />
          </Section>

          {/* Top 10 Slowest Endpoints */}
          <Section title="Top 10 Slowest Endpoints (p95)">
            <SlowestTable rows={data.slowest} />
          </Section>

          {/* Latency Percentiles */}
          <Section title="Latency Percentiles by Endpoint">
            <LatencyTable rows={data.latency} />
          </Section>

          {/* Error Rates */}
          <Section title="Error Rate by Endpoint">
            <ErrorRateTable rows={data.errorRates} />
          </Section>

          {/* Recent Errors */}
          <Section
            title="Recent Errors"
            action={
              <Link
                href="/admin/telemetry/errors"
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                View all →
              </Link>
            }
          >
            <RecentErrorsTable rows={errorsData?.rows ?? []} />
          </Section>
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10">
      <div className="px-5 py-4 border-b border-gray-100 dark:border-white/10 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700 dark:text-primary font-mono">{title}</h2>
        {action}
      </div>
      <div className="p-5">{children}</div>
    </div>
  );
}

function VolumeChart({ rows }: { rows: VolumeRow[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-secondary">No data</p>;
  }

  const maxCount = Math.max(...rows.map((r) => r.count), 1);

  // Fill in all 24 hours
  const now = new Date();
  const hours: Array<{ label: string; count: number }> = [];
  for (let i = 23; i >= 0; i--) {
    const d = new Date(now);
    d.setHours(d.getHours() - i, 0, 0, 0);
    const iso = d.toISOString().slice(0, 13);
    const row = rows.find((r) => r.hour.slice(0, 13) === iso);
    hours.push({ label: `${d.getHours()}:00`, count: row?.count ?? 0 });
  }

  return (
    <div className="overflow-x-auto">
      <div className="flex items-end gap-0.5 h-24 min-w-[600px]">
        {hours.map((h, i) => {
          const pct = Math.round((h.count / maxCount) * 100);
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1 group">
              <div className="relative flex-1 w-full flex items-end">
                <div
                  className="w-full bg-blue-500 dark:bg-blue-400 -t transition-all"
                  style={{ height: `${pct}%`, minHeight: h.count > 0 ? '2px' : '0' }}
                  title={`${h.label}: ${h.count} req`}
                />
              </div>
              {i % 4 === 0 && (
                <span className="text-[9px] text-secondary leading-none">{h.label}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SlowestTable({ rows }: { rows: SlowestRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-secondary">No data</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-secondary dark:text-secondary border-b border-gray-100 dark:border-white/10">
            <th className="text-left pb-2 font-medium">Endpoint</th>
            <th className="text-right pb-2 font-medium">Requests</th>
            <th className="text-right pb-2 font-medium">p95</th>
            <th className="text-right pb-2 font-medium">Max</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-white/10/50">
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="py-2 pr-4">
                <span className="text-xs font-mono text-secondary dark:text-secondary mr-2">
                  {r.method}
                </span>
                <span className="font-mono text-xs text-gray-900 dark:text-primary">{r.path}</span>
              </td>
              <td className="py-2 text-right text-muted dark:text-secondary tabular-nums">
                {r.total_requests.toLocaleString()}
              </td>
              <td className="py-2 text-right font-medium text-warning dark:text-warning tabular-nums">
                {r.p95}ms
              </td>
              <td className="py-2 text-right text-secondary dark:text-secondary tabular-nums">
                {r.max_ms}ms
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LatencyTable({ rows }: { rows: LatencyRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-secondary">No data</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-secondary dark:text-secondary border-b border-gray-100 dark:border-white/10">
            <th className="text-left pb-2 font-medium">Endpoint</th>
            <th className="text-right pb-2 font-medium">Requests</th>
            <th className="text-right pb-2 font-medium">p50</th>
            <th className="text-right pb-2 font-medium">p95</th>
            <th className="text-right pb-2 font-medium">p99</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-white/10/50">
          {rows.map((r, i) => (
            <tr key={i}>
              <td className="py-2 pr-4">
                <span className="text-xs font-mono text-secondary dark:text-secondary mr-2">
                  {r.method}
                </span>
                <span className="font-mono text-xs text-gray-900 dark:text-primary">{r.path}</span>
              </td>
              <td className="py-2 text-right text-muted dark:text-secondary tabular-nums">
                {r.total_requests.toLocaleString()}
              </td>
              <td className="py-2 text-right text-muted dark:text-secondary tabular-nums">{r.p50}ms</td>
              <td className="py-2 text-right text-warning dark:text-warning tabular-nums">{r.p95}ms</td>
              <td className="py-2 text-right text-error dark:text-error tabular-nums">{r.p99}ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ErrorRateTable({ rows }: { rows: ErrorRateRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-secondary">No data</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-secondary dark:text-secondary border-b border-gray-100 dark:border-white/10">
            <th className="text-left pb-2 font-medium">Endpoint</th>
            <th className="text-right pb-2 font-medium">Requests</th>
            <th className="text-right pb-2 font-medium">Errors</th>
            <th className="text-right pb-2 font-medium">Rate</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-white/10/50">
          {rows.map((r, i) => {
            const rate = parseFloat(r.error_rate);
            const rateColor =
              rate >= 10
                ? 'text-error dark:text-error'
                : rate >= 1
                ? 'text-warning dark:text-warning'
                : 'text-success dark:text-success';
            return (
              <tr key={i}>
                <td className="py-2 pr-4">
                  <span className="text-xs font-mono text-secondary dark:text-secondary mr-2">
                    {r.method}
                  </span>
                  <span className="font-mono text-xs text-gray-900 dark:text-primary">{r.path}</span>
                </td>
                <td className="py-2 text-right text-muted dark:text-secondary tabular-nums">
                  {r.total_requests.toLocaleString()}
                </td>
                <td className="py-2 text-right text-muted dark:text-secondary tabular-nums">
                  {r.error_count.toLocaleString()}
                </td>
                <td className={`py-2 text-right font-medium tabular-nums ${rateColor}`}>
                  {r.error_rate}%
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RecentErrorsTable({ rows }: { rows: RecentError[] }) {
  if (rows.length === 0) return <p className="text-sm text-secondary">No recent errors</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-secondary dark:text-secondary border-b border-gray-100 dark:border-white/10">
            <th className="text-left pb-2 font-medium">Time</th>
            <th className="text-left pb-2 font-medium">Service</th>
            <th className="text-left pb-2 font-medium">Endpoint</th>
            <th className="text-left pb-2 font-medium">Status</th>
            <th className="text-left pb-2 font-medium">Correlation</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50 dark:divide-white/10/50">
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="py-2 pr-3 text-xs text-secondary dark:text-secondary whitespace-nowrap tabular-nums">
                {new Date(r.created_at).toLocaleTimeString()}
              </td>
              <td className="py-2 pr-3 text-xs text-gray-700 dark:text-primary">{r.service}</td>
              <td className="py-2 pr-3 font-mono text-xs text-gray-900 dark:text-primary">
                <span className="text-secondary dark:text-secondary mr-1">{r.method}</span>
                {r.path}
              </td>
              <td className="py-2 pr-3">
                <StatusBadge status={r.status} />
              </td>
              <td className="py-2">
                {r.correlation_id ? (
                  <Link
                    href={`/admin/telemetry/trace/${r.correlation_id}`}
                    className="font-mono text-xs text-blue-600 dark:text-blue-400 hover:underline truncate max-w-[120px] inline-block"
                    title={r.correlation_id}
                  >
                    {r.correlation_id.slice(0, 16)}…
                  </Link>
                ) : (
                  <span className="text-secondary text-xs">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
