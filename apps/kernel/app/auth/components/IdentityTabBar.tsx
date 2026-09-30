'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSyncExternalStore } from 'react';
import { getServiceBadges, subscribeServiceBadges } from '../lib/service-badge-bus';
import type { NavApp } from '@/src/lib/kernel/app-nav';

interface Props {
  showSettings: boolean;
  showMembers: boolean;
  showSecurity: boolean;
  showMoney: boolean;
  showTax: boolean;
  /** Pay/Media are kernel-native services (never pruned), gated directly rather than via `apps` (#2425). */
  showPay: boolean;
  showMedia: boolean;
  /** Registry-driven extractable apps (coffee/dykil/links/learn/events/market) enabled for this identity (#2425). */
  apps: readonly NavApp[];
  landingService?: string | null;
}

interface Tab {
  label: string;
  href: string;
  exact: boolean;
}

const ALL_TABS: Tab[] = [
  { label: 'Profile', href: '/auth', exact: true },
  { label: 'Agents', href: '/auth/agents', exact: false },
  { label: 'Attestations', href: '/auth/attestations', exact: false },
  { label: 'Documents', href: '/auth/attestations?view=documents', exact: false },
  { label: 'Notifications', href: '/auth/notifications', exact: false },
  { label: 'Developer', href: '/auth/developer/apps', exact: false },
  { label: 'Connected apps', href: '/auth/apps', exact: false },
  { label: 'Connections', href: '/auth/connectors', exact: false },
  { label: 'Money', href: '/auth/money', exact: false },
  { label: 'Tax', href: '/auth/tax', exact: false },
  { label: 'Corpus', href: '/auth/corpus', exact: false },
  { label: 'Security', href: '/auth/security', exact: false },
  { label: 'Settings', href: '/auth/settings', exact: false },
  { label: 'Members', href: '/auth/members', exact: false },
];

/** Kernel-native tabs (#2425) — never pruned, so they stay a small fixed list rather than registry rows. */
const KERNEL_NATIVE_TABS: Record<'pay' | 'media', Tab> = {
  pay: { label: 'Pay', href: '/auth/pay', exact: false },
  media: { label: 'Media', href: '/auth/media', exact: false },
};

function serviceFromHref(href: string): string {
  return href.split('/').pop() ?? '';
}

function navAppToTab(app: NavApp): Tab {
  return { label: app.name, href: `/auth/${app.slug}`, exact: false };
}

function TabLink({ tab, pathname, badge = 0 }: Readonly<{ tab: Tab; pathname: string; badge?: number }>) {
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
      {badge > 0 && (
        <span className="ml-1.5 inline-flex min-w-[1.1rem] items-center justify-center rounded-full bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold leading-none text-black">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </Link>
  );
}

export default function IdentityTabBar({
  showSettings,
  showMembers,
  showSecurity,
  showMoney,
  showTax,
  showPay,
  showMedia,
  apps,
}: Readonly<Props>) {
  const pathname = usePathname();
  const badges = useSyncExternalStore(subscribeServiceBadges, getServiceBadges, getServiceBadges);

  const tabs = ALL_TABS.filter((tab) => {
    if (tab.href === '/auth/security') return showSecurity;
    if (tab.href === '/auth/settings') return showSettings;
    if (tab.href === '/auth/members') return showMembers;
    if (tab.href === '/auth/money') return showMoney;
    if (tab.href === '/auth/tax') return showTax;
    return true;
  });

  const serviceTabs: Tab[] = [
    ...apps.map(navAppToTab),
    ...(showPay ? [KERNEL_NATIVE_TABS.pay] : []),
    ...(showMedia ? [KERNEL_NATIVE_TABS.media] : []),
  ];

  return (
    <div className="border-b border-zinc-800 flex gap-1 flex-wrap">
      {tabs.map((tab) => (
        <TabLink key={tab.href} tab={tab} pathname={pathname} />
      ))}
      {serviceTabs.length > 0 && (
        <div className="flex items-center mx-1">
          <div className="w-px h-5 bg-zinc-700" />
        </div>
      )}
      {serviceTabs.map((tab) => (
        <TabLink key={tab.href} tab={tab} pathname={pathname} badge={badges[serviceFromHref(tab.href)]} />
      ))}
    </div>
  );
}
