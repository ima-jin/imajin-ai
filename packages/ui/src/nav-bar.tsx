'use client';

import React, { useState, useEffect, useRef } from 'react';

export interface NavIdentity {
  isLoggedIn: boolean;
  handle?: string | null;
  did?: string | null;
  onLogout?: () => void;
  onViewProfile?: () => void;
  onEditProfile?: () => void;
  onLogin?: () => void;
  onRegister?: () => void;
}

export interface NavBarProps {
  currentService?: string;
  servicePrefix?: string;
  domain?: string;
  identity?: NavIdentity;
}

function buildServices(prefix: string, domain: string) {
  return [
    { name: 'Home', href: `${prefix}www.${domain}` },
    { name: 'Events', href: `${prefix}events.${domain}` },
  ];
}

function buildUserLinks(prefix: string, domain: string) {
  return {
    connections: `${prefix}connections.${domain}`,
    messages: `${prefix}chat.${domain}`,
    profile: `${prefix}profile.${domain}`,
  };
}

/**
 * Hook that auto-fetches identity from auth service when no identity prop is provided.
 * Uses the cross-domain session cookie on .imajin.ai
 */
function useAutoIdentity(servicePrefix: string, domain: string): NavIdentity | null {
  const [identity, setIdentity] = useState<NavIdentity | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const authUrl = `${servicePrefix}auth.${domain}`;
    const profileUrl = `${servicePrefix}profile.${domain}`;

    async function checkSession() {
      try {
        const res = await fetch(`${authUrl}/api/session`, {
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          setIdentity({
            isLoggedIn: true,
            handle: data.handle || null,
            did: data.did || null,
            onLogout: async () => {
              try {
                await fetch(`${authUrl}/api/logout`, {
                  method: 'POST',
                  credentials: 'include',
                });
              } catch {}
              setIdentity({
                isLoggedIn: false,
                onLogin: () => { window.location.href = `${profileUrl}/login`; },
                onRegister: () => { window.location.href = `${authUrl}/register`; },
              });
            },
            onViewProfile: data.handle
              ? () => { window.location.href = `${profileUrl}/${data.handle}`; }
              : data.did
              ? () => { window.location.href = `${profileUrl}/${data.did}`; }
              : undefined,
            onEditProfile: () => { window.location.href = `${profileUrl}/edit`; },
            onLogin: () => { window.location.href = `${profileUrl}/login`; },
            onRegister: () => { window.location.href = `${authUrl}/register`; },
          });
        } else {
          setIdentity({
            isLoggedIn: false,
            onLogin: () => { window.location.href = `${profileUrl}/login`; },
            onRegister: () => { window.location.href = `${authUrl}/register`; },
          });
        }
      } catch {
        // Auth service unreachable — don't show identity section
        setIdentity(null);
      }
    }

    checkSession();
  }, [servicePrefix, domain]);

  return identity;
}

export function NavBar({ 
  currentService, 
  servicePrefix = 'https://', 
  domain = 'imajin.ai',
  identity: identityProp,
}: NavBarProps) {
  const services = buildServices(servicePrefix, domain);
  const userLinks = buildUserLinks(servicePrefix, domain);
  const isDev = servicePrefix.includes('dev-');
  const [showDropdown, setShowDropdown] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Auto-fetch identity if no prop provided
  const autoIdentity = useAutoIdentity(servicePrefix, domain);
  const identity = identityProp ?? autoIdentity;

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

  return (
    <nav className="w-full border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm">
      {isDev && (
        <div className="w-full bg-amber-500/90 text-black text-xs font-bold text-center py-1 tracking-wide">
          ⚠ DEVELOPMENT ENVIRONMENT
        </div>
      )}
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
        {/* Logo */}
        <a
          href={`${servicePrefix}www.${domain}`}
          className="flex items-center gap-2 font-bold text-lg hover:opacity-80 transition"
        >
          <span className="text-2xl">🟠</span>
          <span>Imajin</span>
        </a>

        {/* Center - Nav Links (desktop) */}
        <div className="hidden sm:flex items-center gap-1">
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

        {/* Mobile hamburger */}
        <button
          onClick={() => setShowMobileMenu(!showMobileMenu)}
          className="sm:hidden p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
        >
          <span className="text-xl">{showMobileMenu ? '✕' : '☰'}</span>
        </button>

        {/* Right - Auth Section */}
        <div className="flex items-center gap-2">
          {identity?.isLoggedIn ? (
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                <span className="text-xl">👤</span>
                <span className="text-sm font-medium">
                  {identity.handle ? `@${identity.handle}` : identity.did?.slice(0, 12) + '...'}
                </span>
              </button>

              {showDropdown && (
                <div className="absolute right-0 mt-2 w-52 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-lg py-1 z-50">
                  {identity.onViewProfile && (
                    <button
                      onClick={() => { identity.onViewProfile?.(); setShowDropdown(false); }}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2"
                    >
                      <span>👤</span> View Profile
                    </button>
                  )}
                  {identity.onEditProfile && (
                    <button
                      onClick={() => { identity.onEditProfile?.(); setShowDropdown(false); }}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2"
                    >
                      <span>✏️</span> Edit Profile
                    </button>
                  )}
                  <hr className="my-1 border-gray-200 dark:border-gray-800" />
                  <a
                    href={userLinks.messages}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2 no-underline text-inherit"
                  >
                    <span>💬</span> Messages
                  </a>
                  <a
                    href={userLinks.connections}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2 no-underline text-inherit"
                  >
                    <span>🤝</span> Connections
                  </a>
                  {identity.onLogout && (
                    <>
                      <hr className="my-1 border-gray-200 dark:border-gray-800" />
                      <button
                        onClick={() => { identity.onLogout?.(); setShowDropdown(false); }}
                        className="w-full text-left px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2"
                      >
                        <span>🚪</span> Logout
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          ) : identity ? (
            <>
              {identity.onLogin && (
                <button
                  onClick={identity.onLogin}
                  className="px-3 py-1.5 rounded-lg text-sm bg-[#F59E0B] text-black hover:bg-[#D97706] transition font-medium"
                >
                  Login
                </button>
              )}
            </>
          ) : null}
        </div>
      </div>

      {/* Mobile menu */}
      {showMobileMenu && (
        <div className="sm:hidden border-t border-gray-200 dark:border-gray-800 px-4 py-3 space-y-1">
          {services.map((service) => {
            const isCurrent = service.name === currentService;
            return (
              <a
                key={service.name}
                href={service.href}
                className={`block px-3 py-2 rounded-lg text-sm transition ${
                  isCurrent
                    ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 font-medium'
                    : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`}
              >
                {service.name}
              </a>
            );
          })}
          {identity?.isLoggedIn && (
            <>
              <hr className="my-2 border-gray-200 dark:border-gray-800" />
              <a href={userLinks.messages} className="block px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 no-underline">💬 Messages</a>
              <a href={userLinks.connections} className="block px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 no-underline">🤝 Connections</a>
            </>
          )}
        </div>
      )}
    </nav>
  );
}
