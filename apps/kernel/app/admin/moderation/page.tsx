import { getClient } from '@imajin/db';
import { formatDistanceToNow } from 'date-fns';
import { FlagActions } from './flag-actions';
import { CreateFlag } from './create-flag';

const sql = getClient();

export default async function AdminModerationPage() {
  const pendingFlags = await sql`
    SELECT f.*, p.display_name AS reporter_name
    FROM registry.flags f
    LEFT JOIN profile.profiles p ON f.reporter_did = p.did
    WHERE f.status = 'pending'
    ORDER BY f.created_at DESC
  `;

  const auditLog = await sql`
    SELECT m.*, p.display_name AS operator_name
    FROM registry.moderation_log m
    LEFT JOIN profile.profiles p ON m.operator_did = p.did
    ORDER BY m.created_at DESC
    LIMIT 25
  `;

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-primary font-mono">Moderation</h1>
          <p className="mt-1 text-sm text-secondary dark:text-secondary">
            Flag queue and moderation audit log
          </p>
        </div>
        <CreateFlag />
      </div>

      {/* Flag Queue */}
      <div className="mb-8">
        <h2 className="text-sm font-semibold text-secondary dark:text-secondary uppercase tracking-wide mb-3 font-mono">
          Pending Flags
          {pendingFlags.length > 0 && (
            <span className="ml-2 bg-imajin-orange/10 dark:bg-imajin-orange/20 text-imajin-orange dark:text-imajin-orange px-2 py-0.5 text-xs">
              {pendingFlags.length}
            </span>
          )}
        </h2>

        {pendingFlags.length === 0 ? (
          <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 px-6 py-10 text-center">
            <p className="text-sm text-secondary dark:text-secondary">No pending flags</p>
          </div>
        ) : (
          <div className="space-y-4">
            {pendingFlags.map((flag) => {
              const flagId = flag.id as string;
              const createdAt = flag.created_at as Date;
              const reporterName = (flag.reporter_name ?? flag.reporter_did) as string;
              return (
                <div
                  key={flagId}
                  className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-5"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-1 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs bg-imajin-orange/10 dark:bg-imajin-orange/20 text-imajin-orange dark:text-imajin-orange px-2 py-0.5 font-medium">
                          {flag.target_type as string}
                        </span>
                        <span className="font-mono text-xs text-secondary dark:text-secondary">
                          {String(flag.target_id).slice(0, 24)}…
                        </span>
                      </div>
                      <p className="text-sm font-medium text-gray-900 dark:text-primary">
                        {flag.reason as string}
                      </p>
                      <div className="text-xs text-secondary dark:text-secondary space-x-2">
                        <span>Reporter: <span className="text-gray-700 dark:text-primary">{reporterName}</span></span>
                        <span>·</span>
                        <span>Target: <span className="font-mono">{String(flag.target_did).slice(0, 20)}…</span></span>
                        <span>·</span>
                        <span>{createdAt ? formatDistanceToNow(new Date(createdAt), { addSuffix: true }) : '—'}</span>
                      </div>
                    </div>
                  </div>
                  <FlagActions flagId={flagId} targetDid={flag.target_did as string} />
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Audit Log */}
      <div>
        <h2 className="text-sm font-semibold text-secondary dark:text-secondary uppercase tracking-wide mb-3 font-mono">
          Audit Log
        </h2>
        <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 overflow-hidden">
          {auditLog.length === 0 ? (
            <p className="px-6 py-8 text-sm text-secondary dark:text-secondary text-center">
              No moderation actions recorded
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 dark:bg-surface-elevated/50 border-b border-gray-100 dark:border-white/10">
                    <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Operator</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Action</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Target</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Reason</th>
                    <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">When</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-white/10">
                  {auditLog.map((entry) => {
                    const id = entry.id as string;
                    const createdAt = entry.created_at as Date;
                    const operatorName = (entry.operator_name ?? entry.operator_did) as string;
                    return (
                      <tr key={id} className="hover:bg-gray-50 dark:hover:bg-surface-elevated/40">
                        <td className="px-4 py-3 text-xs text-gray-700 dark:text-primary">
                          {operatorName}
                        </td>
                        <td className="px-4 py-3">
                          <ActionBadge action={entry.action as string} />
                        </td>
                        <td className="px-4 py-3 font-mono text-xs text-secondary dark:text-secondary">
                          {String(entry.target_did).slice(0, 20)}…
                        </td>
                        <td className="px-4 py-3 text-xs text-secondary dark:text-secondary max-w-xs truncate">
                          {(entry.reason as string | null) ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-xs text-secondary dark:text-secondary whitespace-nowrap">
                          {createdAt ? formatDistanceToNow(new Date(createdAt), { addSuffix: true }) : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ActionBadge({ action }: { action: string }) {
  const styles: Record<string, string> = {
    suspend: 'bg-imajin-orange/10 dark:bg-imajin-orange/20 text-imajin-orange dark:text-imajin-orange',
    unsuspend: 'bg-success/10 dark:bg-success/40 text-success dark:text-success',
    ban: 'bg-error/10 dark:bg-error/40 text-error dark:text-error',
    warn: 'bg-yellow-100 dark:bg-warning/20/40 text-warning dark:text-warning',
    dismiss_flag: 'bg-gray-100 dark:bg-surface-elevated text-muted dark:text-secondary',
    remove_content: 'bg-error/10 dark:bg-error/40 text-error dark:text-error',
  };
  return (
    <span className={`text-xs px-2 py-0.5  ${styles[action] ?? styles.dismiss_flag}`}>
      {action.replace(/_/g, ' ')}
    </span>
  );
}
