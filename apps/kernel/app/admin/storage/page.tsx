import { getClient } from '@imajin/db';
import { formatDistanceToNow } from 'date-fns';

const sql = getClient();

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export default async function AdminStoragePage() {
  const [totals] = await sql`
    SELECT
      COUNT(*) AS total_assets,
      COALESCE(SUM(size), 0) AS total_size,
      COUNT(DISTINCT owner_did) AS unique_uploaders
    FROM media.assets
    WHERE status != 'deleted'
  `;

  const topUploaders = await sql`
    SELECT
      a.owner_did,
      COUNT(*) AS asset_count,
      SUM(a.size) AS total_size,
      p.display_name
    FROM media.assets a
    LEFT JOIN profile.profiles p ON a.owner_did = p.did
    WHERE a.status != 'deleted'
    GROUP BY a.owner_did, p.display_name
    ORDER BY total_size DESC
    LIMIT 10
  `;

  const recentAssets = await sql`
    SELECT id, filename, mime_type, size, owner_did, created_at
    FROM media.assets
    WHERE status != 'deleted'
    ORDER BY created_at DESC
    LIMIT 20
  `;

  const orphans = await sql`
    SELECT a.id, a.filename, a.mime_type, a.size, a.created_at
    FROM media.assets a
    LEFT JOIN media.asset_references r ON a.id = r.asset_id
    WHERE r.id IS NULL
      AND a.status != 'deleted'
    ORDER BY a.created_at DESC
    LIMIT 20
  `;

  const totalAssets = Number(totals?.total_assets ?? 0);
  const totalSize = Number(totals?.total_size ?? 0);
  const uniqueUploaders = Number(totals?.unique_uploaders ?? 0);

  return (
    <div className="p-6 lg:p-8 max-w-6xl">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-primary font-mono">Storage</h1>
        <p className="mt-1 text-sm text-secondary dark:text-secondary">
          Media assets and storage usage
        </p>
      </div>

      {/* Overview stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-5">
          <p className="text-xs text-secondary dark:text-secondary uppercase tracking-wide mb-1">Total Assets</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-primary">{totalAssets.toLocaleString()}</p>
        </div>
        <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-5">
          <p className="text-xs text-secondary dark:text-secondary uppercase tracking-wide mb-1">Total Size</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-primary">{formatBytes(totalSize)}</p>
        </div>
        <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 p-5">
          <p className="text-xs text-secondary dark:text-secondary uppercase tracking-wide mb-1">Unique Uploaders</p>
          <p className="text-2xl font-bold text-gray-900 dark:text-primary">{uniqueUploaders.toLocaleString()}</p>
        </div>
      </div>

      {/* Top Uploaders */}
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 overflow-hidden mb-6">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-white/10">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-primary font-mono">Top Uploaders</h2>
        </div>
        {topUploaders.length === 0 ? (
          <p className="px-6 py-8 text-sm text-secondary dark:text-secondary text-center">No assets yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-surface-elevated/50 border-b border-gray-100 dark:border-white/10">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Owner</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Assets</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Total Size</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-white/10">
                {topUploaders.map((row) => {
                  const ownerDid = row.owner_did as string;
                  const displayName = row.display_name as string | null;
                  return (
                    <tr key={ownerDid} className="hover:bg-gray-50 dark:hover:bg-surface-elevated/40">
                      <td className="px-4 py-3">
                        {displayName && (
                          <p className="text-sm text-gray-900 dark:text-primary">{displayName}</p>
                        )}
                        <p className="font-mono text-xs text-secondary dark:text-secondary">
                          {ownerDid.slice(0, 32)}…
                        </p>
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-primary">
                        {Number(row.asset_count).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-gray-700 dark:text-primary">
                        {formatBytes(Number(row.total_size ?? 0))}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent Assets */}
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 overflow-hidden mb-6">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-white/10">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-primary font-mono">Recent Assets</h2>
        </div>
        {recentAssets.length === 0 ? (
          <p className="px-6 py-8 text-sm text-secondary dark:text-secondary text-center">No assets yet</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-surface-elevated/50 border-b border-gray-100 dark:border-white/10">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Filename</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Type</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Size</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Owner</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Uploaded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-white/10">
                {recentAssets.map((asset) => {
                  const id = asset.id as string;
                  const createdAt = asset.created_at as Date;
                  return (
                    <tr key={id} className="hover:bg-gray-50 dark:hover:bg-surface-elevated/40">
                      <td className="px-4 py-3 font-mono text-xs text-gray-900 dark:text-primary">
                        {asset.filename ? String(asset.filename) : id.slice(0, 16) + '…'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs bg-gray-100 dark:bg-surface-elevated text-muted dark:text-secondary px-2 py-0.5 ">
                          {asset.mime_type as string}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-700 dark:text-primary">
                        {formatBytes(Number(asset.size ?? 0))}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-secondary dark:text-secondary">
                        {String(asset.owner_did).slice(0, 20)}…
                      </td>
                      <td className="px-4 py-3 text-xs text-secondary dark:text-secondary whitespace-nowrap">
                        {createdAt
                          ? formatDistanceToNow(new Date(createdAt), { addSuffix: true })
                          : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Orphan Detection */}
      <div className="bg-white dark:bg-surface-elevated border border-gray-100 dark:border-white/10 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-white/10 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-primary font-mono">Orphaned Assets</h2>
          <span className="text-xs text-secondary dark:text-secondary">
            {orphans.length} found (showing first 20)
          </span>
        </div>
        {orphans.length === 0 ? (
          <p className="px-6 py-8 text-sm text-secondary dark:text-secondary text-center">
            No orphaned assets found
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-gray-50 dark:bg-surface-elevated/50 border-b border-gray-100 dark:border-white/10">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Filename</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Type</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Size</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-secondary dark:text-secondary uppercase tracking-wide">Uploaded</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-white/10">
                {orphans.map((asset) => {
                  const id = asset.id as string;
                  const createdAt = asset.created_at as Date;
                  return (
                    <tr key={id} className="hover:bg-gray-50 dark:hover:bg-surface-elevated/40">
                      <td className="px-4 py-3 font-mono text-xs text-gray-900 dark:text-primary">
                        {asset.filename ? String(asset.filename) : id.slice(0, 16) + '…'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs bg-yellow-100 dark:bg-warning/20/40 text-warning dark:text-warning px-2 py-0.5 ">
                          {asset.mime_type as string}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-700 dark:text-primary">
                        {formatBytes(Number(asset.size ?? 0))}
                      </td>
                      <td className="px-4 py-3 text-xs text-secondary dark:text-secondary whitespace-nowrap">
                        {createdAt
                          ? formatDistanceToNow(new Date(createdAt), { addSuffix: true })
                          : '—'}
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
  );
}
