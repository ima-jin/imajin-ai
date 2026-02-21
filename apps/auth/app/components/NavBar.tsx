'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const services = [
  { name: 'Home', href: 'https://imajin.ai', external: true },
  { name: 'Auth', href: 'https://auth.imajin.ai' },
  { name: 'Profile', href: 'https://profile.imajin.ai' },
  { name: 'Events', href: 'https://events.imajin.ai' },
  { name: 'Chat', href: 'https://chat.imajin.ai' },
  { name: 'Registry', href: 'https://registry.imajin.ai' },
];

interface NavBarProps {
  currentService?: string;
}

export function NavBar({ currentService = 'Auth' }: NavBarProps) {
  return (
    <nav className="w-full border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm">
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
        {/* Logo */}
        <a 
          href="https://imajin.ai" 
          className="flex items-center gap-2 font-bold text-lg hover:opacity-80 transition"
        >
          <span className="text-2xl">🟠</span>
          <span>Imajin</span>
        </a>
        
        {/* Links */}
        <div className="flex items-center gap-1">
          {services.map((service) => {
            const isCurrent = service.name === currentService;
            return (
              <a
                key={service.name}
                href={service.href}
                className={`px-3 py-1.5 rounded-lg text-sm transition ${
                  isCurrent
                    ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 font-medium'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                {service.name}
              </a>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
