'use client';

import { usePathname } from 'next/navigation';

const BYPASS_PREFIXES = ['/auth/login', '/auth/register', '/auth/onboard'];

interface Props {
  leftRail: React.ReactNode;
  identityDetail: React.ReactNode;
  tabBar: React.ReactNode;
  children: React.ReactNode;
}

export default function AuthLayoutShell({ leftRail, identityDetail, tabBar, children }: Props) {
  const pathname = usePathname();

  if (BYPASS_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return <>{children}</>;
  }

  return (
    <div className="flex flex-col lg:flex-row gap-6 min-h-[calc(100vh-4rem)]">
      {/* Left rail (desktop) / Top section (mobile) */}
      <div className="lg:w-72 lg:shrink-0">
        <div className="sticky top-6 bg-[#0a0a0a] border border-white/10 p-4">
          <h2 className="text-xs font-semibold text-muted uppercase tracking-wider mb-3 px-1 font-mono">
            Identities
          </h2>
          {leftRail}
        </div>
      </div>

      {/* Main area */}
      <div className="flex-1 min-w-0">
        <div className="space-y-4">
          {identityDetail}
          <div>
            {tabBar}
            <div className="pt-4">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
