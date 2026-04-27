'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface SubNavProps {
  isAuthenticated: boolean;
}

export function SubNav({ isAuthenticated }: SubNavProps) {
  const pathname = usePathname();

  // Don't show on public pages (handle pages)
  if (pathname.startsWith('/') && pathname.split('/').length === 2 && pathname !== '/') {
    return null;
  }

  return (
    <div className="bg-white dark:bg-surface-surface border-b border-white/10 dark:border-white/10">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex gap-6 py-3">
          <Link
            href="/"
            className={`text-sm font-medium transition ${ pathname === '/' ? 'text-imajin-orange' : 'text-muted dark:text-secondary:text-primary dark:hover:text-primary' }`}
          >
            Home
          </Link>

          {isAuthenticated && (
            <>
              <Link
                href="/edit"
                className={`text-sm font-medium transition ${ pathname === '/edit' ? 'text-imajin-orange' : 'text-muted dark:text-secondary:text-primary dark:hover:text-primary' }`}
              >
                Edit
              </Link>

              <Link
                href="/dashboard"
                className={`text-sm font-medium transition ${ pathname === '/dashboard' ? 'text-imajin-orange' : 'text-muted dark:text-secondary:text-primary dark:hover:text-primary' }`}
              >
                Stats
              </Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
