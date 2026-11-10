import postgres from 'postgres';

/** Keep selection and termination in one statement; never broaden this predicate. */
export const STUCK_BACKEND_PREDICATE = `
  datname = current_database()
  AND usename = current_user
  AND backend_type = 'client backend'
  AND pid <> pg_backend_pid()
  AND state = 'active'
  AND wait_event = 'ClientRead'
  AND now() - state_change > ($1 * interval '1 second')
`;

export const REAP_STUCK_BACKENDS_SQL = `
  SELECT pid, EXTRACT(EPOCH FROM (now() - state_change)) AS age_seconds,
    query, application_name, pg_terminate_backend(pid) AS terminated
  FROM pg_stat_activity
  WHERE ${STUCK_BACKEND_PREDICATE}
`;

interface ReapedBackend {
  pid: number;
  age_seconds: number;
  query: string;
  application_name: string;
  terminated: boolean;
}

type ReaperLog = (entry: { level: 'warn' | 'error'; event: string; [key: string]: unknown }) => void;
interface ReaperClient {
  unsafe(query: string, parameters: number[]): PromiseLike<ReapedBackend[]>;
  end(options: { timeout: number }): Promise<void>;
}

export function reaperThreshold(env: NodeJS.ProcessEnv): number {
  const value = env.DB_REAPER_THRESHOLD_SECONDS ?? '300';
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error('DB_REAPER_THRESHOLD_SECONDS must be a positive integer');
  }
  return Number(value);
}

/** Raw SQL can contain secrets. Log only its leading command, never literals. */
function queryPrefix(query: string): string {
  return /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|BEGIN|COMMIT|ROLLBACK)\b/i.exec(query)?.[1] ?? '[redacted]';
}

export async function reapStuckBackends(client: ReaperClient, threshold: number, log: ReaperLog): Promise<void> {
  const rows = await client.unsafe(REAP_STUCK_BACKENDS_SQL, [threshold]);
  for (const row of rows) {
    log({
      level: row.terminated ? 'warn' : 'error',
      event: 'db.reaper',
      pid: row.pid,
      age_seconds: Number(row.age_seconds),
      query_prefix: queryPrefix(row.query),
      application_name: row.application_name,
      terminated: row.terminated,
    });
  }
}

/** Independent of kernel HTTP and its busy pool; one short-lived socket per tick. */
export function startDatabaseReaper(
  env: NodeJS.ProcessEnv,
  log: ReaperLog,
  createClient: (url: string) => ReaperClient = url => postgres(url, {
    max: 1,
    prepare: false,
    connect_timeout: 5,
    idle_timeout: 5,
    connection: { application_name: 'imajin-db-reaper', statement_timeout: 5000 },
  }),
): { stop: () => void } {
  const threshold = reaperThreshold(env);
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required for the database reaper');
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    let client: ReaperClient | undefined;
    try {
      client = createClient(url);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          reapStuckBackends(client, threshold, log),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('Reaper deadline')), 10_000);
          }),
        ]);
      } finally { clearTimeout(timer); }
    } catch {
      // Driver error messages may contain connection credentials or raw SQL.
      log({ level: 'error', event: 'db.reaper-failed' });
    } finally {
      try { await client?.end({ timeout: 1 }); }
      catch { log({ level: 'error', event: 'db.reaper-close-failed' }); }
      running = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, 60_000);
  return { stop: () => clearInterval(timer) };
}
