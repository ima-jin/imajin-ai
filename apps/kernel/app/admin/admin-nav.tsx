'use client';

import { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface NavItem {
  label: string;
  href: string;
  icon: string;
}

interface AdminNavProps {
  navItems: NavItem[];
  mobile?: boolean;
  nodeName?: string;
}

export default function AdminNav({ navItems, mobile = false, nodeName }: AdminNavProps) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = (href: string) => {
    if (href === '/admin') return pathname === '/admin';
    return pathname.startsWith(href);
  };

  const linkClass = (href: string) =>
    `flex items-center gap-3 px-3 py-2 text-sm font-medium transition-colors ${
      isActive(href)
        ? 'bg-imajin-orange text-primary'
        : 'text-gray-700 dark:text-primary hover:bg-gray-200 dark:hover:bg-surface-elevated hover:text-gray-900 dark:hover:text-primary'
    }`;

  if (mobile) {
    return (
      <>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-base">🖥️</span>
            <span className="font-semibold text-gray-900 dark:text-primary text-sm truncate max-w-[160px]">
              {nodeName || 'Admin Console'}
            </span>
          </div>
          <button
            onClick={() => setMenuOpen(!menuOpen)}
            className="p-2 text-muted dark:text-primary hover:bg-gray-200 dark:hover:bg-surface-elevated"
            aria-label="Toggle menu"
          >
            {menuOpen ? '✕' : '☰'}
          </button>
        </div>

        {menuOpen && (
          <div className="mt-3 pb-2 border-t border-gray-200 dark:border-white/10 pt-3 space-y-1">
            {navItems.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className={linkClass(item.href)}
                onClick={() => setMenuOpen(false)}
              >
                <span>{item.icon}</span>
                <span>{item.label}</span>
              </Link>
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <ul className="space-y-1">
      {navItems.map((item) => (
        <li key={item.href}>
          <Link href={item.href} className={linkClass(item.href)}>
            <span>{item.icon}</span>
            <span>{item.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
