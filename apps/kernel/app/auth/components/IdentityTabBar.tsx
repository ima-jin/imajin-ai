'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Props {
  showSettings: boolean;
  showMembers: boolean;
}

interface Tab {
  label: string;
  href: string;
  exact: boolean;
}

const ALL_TABS: Tab[] = [
  { label: 'Profile', href: '/auth', exact: true },
  { label: 'Attestations', href: '/auth/attestations', exact: false },
  { label: 'Developer', href: '/auth/developer/apps', exact: false },
  { label: 'Apps', href: '/auth/apps', exact: false },
  { label: 'Settings', href: '/auth/settings', exact: false },
  { label: 'Members', href: '/auth/members', exact: false },
];

export default function IdentityTabBar({ showSettings, showMembers }: Props) {
  const pathname = usePathname();

  const tabs = ALL_TABS.filter((tab) => {
    if (tab.href === '/auth/settings') return showSettings;
    if (tab.href === '/auth/members') return showMembers;
    return true;
  });

  return (
    <div className="border-b border-zinc-800 flex gap-1">
      {tabs.map((tab) => {
        const isActive = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              isActive
                ? 'border-amber-500 text-amber-400'
                : 'border-transparent text-zinc-400 hover:text-white hover:border-zinc-600'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
