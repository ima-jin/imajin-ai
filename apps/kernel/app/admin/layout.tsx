import { redirect } from 'next/navigation';
import { getSession } from '@imajin/auth';
import { getClient } from '@imajin/db';
import Link from 'next/link';
import AdminNav from './admin-nav';

const sql = getClient();

const NAV_ITEMS = [
  { label: 'Overview', href: '/admin', icon: '📊' },
  { label: 'Users', href: '/admin/users', icon: '👥' },
  { label: 'Subscribers', href: '/admin/subscribers', icon: '📬' },
  { label: 'Newsletter', href: '/admin/newsletter', icon: '📰' },
  { label: 'Services', href: '/admin/services', icon: '⚙️' },
  { label: 'Federation', href: '/admin/federation', icon: '🌐' },
  { label: 'Storage', href: '/admin/storage', icon: '💾' },
  { label: 'Config', href: '/admin/config', icon: '🔧' },
  { label: 'Moderation', href: '/admin/moderation', icon: '🛡️' },
  { label: 'Events', href: '/admin/events', icon: '🔔' },
  { label: 'Telemetry', href: '/admin/telemetry', icon: '📈' },
];

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session?.actingAs) {
    redirect('/');
  }

  // Verify actingAs is a node-scope group DID
  const [nodeRow] = await sql`
    SELECT group_did FROM auth.group_identities
    WHERE group_did = ${session.actingAs}
    AND scope = 'node'
    LIMIT 1
  `;

  if (!nodeRow) {
    redirect('/');
  }

  const nodeDid: string = session.actingAs;

  // Fetch node profile display name
  const [profileRow] = await sql`
    SELECT display_name FROM profile.profiles
    WHERE did = ${nodeDid}
    LIMIT 1
  `;

  const nodeName: string = (profileRow?.display_name as string) || 'Node';
  const nodeDidShort = `${nodeDid.slice(0, 16)}…${nodeDid.slice(-6)}`;

  return (
    <div className="flex min-h-screen bg-white dark:bg-gray-900">
      {/* Sidebar */}
      <div className="hidden md:flex md:flex-col md:w-64 md:fixed md:inset-y-0 bg-gray-100 dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700">
        {/* Node identity header */}
        <div className="px-4 py-5 border-b border-gray-200 dark:border-gray-700">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">🖥️</span>
            <span className="font-semibold text-gray-900 dark:text-white truncate text-sm">
              {nodeName}
            </span>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 font-mono truncate">
            {nodeDidShort}
          </p>
          <span className="mt-2 inline-block text-xs bg-orange-100 dark:bg-orange-900/40 text-orange-700 dark:text-orange-400 px-2 py-0.5 rounded-full font-medium">
            Admin Console
          </span>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 overflow-y-auto">
          <AdminNav navItems={NAV_ITEMS} />
        </nav>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700">
          <Link
            href="/"
            className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          >
            <span>←</span>
            <span>Back to site</span>
          </Link>
        </div>
      </div>

      {/* Mobile header */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-20 bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <AdminNav navItems={NAV_ITEMS} mobile nodeName={nodeName} />
      </div>

      {/* Main content */}
      <div className="flex-1 md:ml-64">
        <main className="md:pt-0 pt-14 min-h-screen">
          {children}
        </main>
      </div>
    </div>
  );
}
