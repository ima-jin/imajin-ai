'use client';

import { useState, useEffect } from 'react';

interface GroupSummary {
  groupDid: string;
  scope: string;
  name: string;
  handle: string;
  role: string;
  controllers?: Array<{ controllerDid: string; role: string }>;
}

function scopeIcon(scope: string): string {
  if (scope === 'community') return '🏛️';
  if (scope === 'org') return '🏢';
  if (scope === 'family') return '👨‍👩‍👦';
  return '🌲';
}

export default function GroupsPage() {
  const [loading, setLoading] = useState(true);
  const [groups, setGroups] = useState<GroupSummary[]>([]);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/auth/api/groups', { credentials: 'include' });
        if (res.ok) {
          const data = await res.json();
          setGroups(data.groups ?? data ?? []);
        } else if (res.status === 401) {
          window.location.href = '/login?next=/groups';
        }
      } catch (err) {
        console.error('Failed to load forests:', err);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center">
        <div className="text-gray-400">Loading forests…</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] p-4 md:p-8">
      <div className="max-w-2xl mx-auto space-y-6">

        <div>
          <h1 className="text-2xl font-bold text-white mb-1">🌲 Your Forests</h1>
          <p className="text-sm text-gray-400">Manage your group identities.</p>
        </div>

        {groups.length === 0 ? (
          <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8 text-center">
            <p className="text-gray-500 mb-4">You don&apos;t have any forests yet.</p>
            <a
              href="/groups/new"
              className="inline-flex items-center gap-2 px-4 py-2 bg-amber-500 hover:bg-amber-400 text-gray-950 font-semibold rounded-lg transition no-underline"
            >
              🌱 Grow a forest
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            {groups.map(group => (
              <a
                key={group.groupDid}
                href={`/groups/${encodeURIComponent(group.groupDid)}/settings`}
                className="block bg-[#0a0a0a] border border-gray-800 hover:border-gray-700 rounded-2xl p-6 transition no-underline group"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{scopeIcon(group.scope)}</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <p className="text-white font-semibold group-hover:text-amber-400 transition">
                          {group.name || group.handle || group.groupDid.slice(0, 16)}
                        </p>
                        <span className="text-xs text-gray-500 capitalize">({group.scope})</span>
                      </div>
                      {group.handle && (
                        <p className="text-xs text-gray-500">@{group.handle}</p>
                      )}
                      <p className="text-xs text-gray-600 mt-0.5">
                        {group.controllers?.length ?? 1} controller{(group.controllers?.length ?? 1) !== 1 ? 's' : ''}
                      </p>
                    </div>
                  </div>
                  <span className="text-gray-600 group-hover:text-gray-400 transition text-sm">→</span>
                </div>
              </a>
            ))}

            <a
              href="/groups/new"
              className="block border border-dashed border-gray-800 hover:border-gray-600 rounded-2xl p-6 transition no-underline text-center text-gray-500 hover:text-gray-300"
            >
              🌱 Grow a forest
            </a>
          </div>
        )}

      </div>
    </div>
  );
}
