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
    <div className="bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
      <div className="max-w-7xl mx-auto px-4">
        <div className="flex gap-6 py-3">
          <Link
            href="/"
            className={`text-sm font-medium transition ${
              pathname === '/'
                ? 'text-orange-500'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
            }`}
          >
            Home
          </Link>

          {isAuthenticated && (
            <>
              <Link
                href="/edit"
                className={`text-sm font-medium transition ${
                  pathname === '/edit'
                    ? 'text-orange-500'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                }`}
              >
                Edit
              </Link>

              <Link
                href="/dashboard"
                className={`text-sm font-medium transition ${
                  pathname === '/dashboard'
                    ? 'text-orange-500'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100'
                }`}
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
