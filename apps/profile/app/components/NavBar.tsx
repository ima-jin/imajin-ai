'use client';

import { useState, useEffect, useRef } from 'react';
import { useIdentity } from '../context/IdentityContext';
import { useRouter } from 'next/navigation';

const services = [
  { name: 'Home', href: 'https://imajin.ai', external: true },
  { name: 'Auth', href: 'https://auth.imajin.ai' },
  { name: 'Pay', href: 'https://pay.imajin.ai' },
  { name: 'Profile', href: 'https://profile.imajin.ai' },
  { name: 'Events', href: 'https://events.imajin.ai' },
  { name: 'Chat', href: 'https://chat.imajin.ai' },
  { name: 'Registry', href: 'https://registry.imajin.ai' },
];

interface NavBarProps {
  currentService?: string;
}

export function NavBar({ currentService = 'Auth' }: NavBarProps) {
  const router = useRouter();
  const { isLoggedIn, handle, did, logout } = useIdentity();
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }

    if (showDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showDropdown]);

  function handleLogout() {
    logout();
    setShowDropdown(false);
    router.push('/');
  }

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

        {/* Center - Service Links */}
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

        {/* Right - Auth Section */}
        <div className="flex items-center gap-2">
          {isLoggedIn ? (
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                <span className="text-xl">👤</span>
                <span className="text-sm font-medium">
                  {handle ? `@${handle}` : did?.slice(0, 12) + '...'}
                </span>
              </button>

              {showDropdown && (
                <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-lg py-1 z-50">
                  <button
                    onClick={() => {
                      router.push(`/${handle || did}`);
                      setShowDropdown(false);
                    }}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                  >
                    View Profile
                  </button>
                  <button
                    onClick={() => {
                      router.push('/edit');
                      setShowDropdown(false);
                    }}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                  >
                    Edit Profile
                  </button>
                  <hr className="my-1 border-gray-200 dark:border-gray-800" />
                  <button
                    onClick={handleLogout}
                    className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
                  >
                    Logout
                  </button>
                </div>
              )}
            </div>
          ) : (
            <>
              <button
                onClick={() => router.push('/login')}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                Login
              </button>
              <button
                onClick={() => router.push('/register')}
                className="px-3 py-1.5 rounded-lg text-sm bg-[#F59E0B] text-black hover:bg-[#D97706] transition font-medium"
              >
                Register
              </button>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}
