'use client';

import React, { useState, useEffect, useRef } from 'react';

export interface NavIdentity {
  isLoggedIn: boolean;
  handle?: string | null;
  did?: string | null;
  name?: string | null;
  tier?: string | null;
  onLogout?: () => void;
  onViewProfile?: () => void;
  onEditProfile?: () => void;
  onLogin?: () => void;
  onRegister?: () => void;
}

export interface ServiceUrls {
  www?: string;
  events?: string;
  auth?: string;
  connections?: string;
  chat?: string;
  profile?: string;
  pay?: string;
  registry?: string;
}

export interface NavBarProps {
  currentService?: string;
  servicePrefix?: string;
  domain?: string;
  identity?: NavIdentity;
  unreadMessages?: number;
  serviceUrls?: ServiceUrls;
}

function buildUrl(service: string, prefix: string, domain: string, overrides?: ServiceUrls) {
  const url = overrides?.[service as keyof ServiceUrls];
  return url || `${prefix}${service}.${domain}`;
}

// Primary nav items (always visible in top bar)
function buildPrimaryServices(prefix: string, domain: string, overrides?: ServiceUrls) {
  return [
    { name: 'Home', href: buildUrl('www', prefix, domain, overrides) },
    { name: 'Events', href: buildUrl('events', prefix, domain, overrides) },
  ];
}

// Secondary nav items (in hamburger dropdown)
function buildSecondaryServices(prefix: string, domain: string, overrides?: ServiceUrls) {
  return [
    { name: 'Surveys', href: buildUrl('dykil', prefix, domain, overrides) },
    { name: 'Links', href: buildUrl('links', prefix, domain, overrides) },
    { name: 'Coffee', href: buildUrl('coffee', prefix, domain, overrides) },
  ];
}

function buildUserLinks(prefix: string, domain: string, overrides?: ServiceUrls) {
  return {
    connections: buildUrl('connections', prefix, domain, overrides),
    messages: buildUrl('chat', prefix, domain, overrides),
    profile: buildUrl('profile', prefix, domain, overrides),
  };
}

/**
 * Hook that auto-fetches identity from auth service when no identity prop is provided.
 */
function useAutoIdentity(servicePrefix: string, domain: string, overrides?: ServiceUrls): NavIdentity | null {
  const [identity, setIdentity] = useState<NavIdentity | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const authUrl = buildUrl('auth', servicePrefix, domain, overrides);
    const profileUrl = buildUrl('profile', servicePrefix, domain, overrides);

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
            name: data.name || null,
            tier: data.tier || null,
            onLogout: async () => {
              try {
                await fetch(`${authUrl}/api/logout`, {
                  method: 'POST',
                  credentials: 'include',
                });
              } catch {}
              setIdentity({
                isLoggedIn: false,
                onLogin: () => { window.location.href = `${profileUrl}/login?next=${encodeURIComponent(window.location.href)}`; },
                onRegister: () => { window.location.href = `${authUrl}/register`; },
              });
            },
            onViewProfile: data.handle
              ? () => { window.location.href = `${profileUrl}/${data.handle}`; }
              : data.did
              ? () => { window.location.href = `${profileUrl}/${data.did}`; }
              : undefined,
            onEditProfile: () => { window.location.href = `${profileUrl}/edit`; },
            onLogin: () => { window.location.href = `${profileUrl}/login?next=${encodeURIComponent(window.location.href)}`; },
            onRegister: () => { window.location.href = `${authUrl}/register`; },
          });
        } else {
          setIdentity({
            isLoggedIn: false,
            onLogin: () => { window.location.href = `${profileUrl}/login?next=${encodeURIComponent(window.location.href)}`; },
            onRegister: () => { window.location.href = `${authUrl}/register`; },
          });
        }
      } catch {
        setIdentity(null);
      }
    }

    checkSession();
  }, [servicePrefix, domain, overrides]);

  return identity;
}

export function NavBar({
  currentService,
  servicePrefix = 'https://',
  domain = 'imajin.ai',
  identity: identityProp,
  unreadMessages = 0,
  serviceUrls,
}: NavBarProps) {
  const primaryServices = buildPrimaryServices(servicePrefix, domain, serviceUrls);
  const secondaryServices = buildSecondaryServices(servicePrefix, domain, serviceUrls);
  const allServices = [...primaryServices, ...secondaryServices];
  const userLinks = buildUserLinks(servicePrefix, domain, serviceUrls);
  const isDev = servicePrefix.includes('dev-');
  const [showDropdown, setShowDropdown] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const [showAppsMenu, setShowAppsMenu] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const appsRef = useRef<HTMLDivElement>(null);

  // Auto-fetch identity if no prop provided
  const autoIdentity = useAutoIdentity(servicePrefix, domain, serviceUrls);
  const identity = identityProp ?? autoIdentity;

  // Fetch balance from pay service
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    if (!identity?.isLoggedIn || !identity?.did) { setBalance(null); return; }
    const payUrl = buildUrl('pay', servicePrefix, domain, serviceUrls);
    fetch(`${payUrl}/api/balance/${encodeURIComponent(identity.did)}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data?.amount) setBalance(parseFloat(data.amount)); })
      .catch(() => {});
  }, [identity?.isLoggedIn, identity?.did, servicePrefix, domain, serviceUrls]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
      if (appsRef.current && !appsRef.current.contains(event.target as Node)) {
        setShowAppsMenu(false);
      }
    }
    if (showDropdown || showAppsMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showDropdown, showAppsMenu]);

  // Check if current service is in the secondary list
  const currentInSecondary = secondaryServices.some(s => s.name === currentService);

  return (
    <nav className="w-full border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm relative z-50">
      {isDev && (
        <div className="w-full bg-amber-500/90 text-black text-xs font-bold text-center py-1 tracking-wide">
          ⚠ DEVELOPMENT ENVIRONMENT
        </div>
      )}
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
        {/* Logo */}
        <a
          href={buildUrl('www', servicePrefix, domain, serviceUrls)}
          className="flex items-center hover:opacity-80 transition"
        >
          <img src="/images/logo.svg" alt="Imajin" className="h-8" />
        </a>

        {/* Center - Nav Links (desktop) */}
        <div className="hidden sm:flex items-center gap-1">
          {primaryServices.map((service) => {
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

          {/* Apps dropdown */}
          <div className="relative" ref={appsRef}>
            <button
              onClick={() => setShowAppsMenu(!showAppsMenu)}
              className={`px-3 py-1.5 rounded-lg text-sm transition flex items-center gap-1 ${
                currentInSecondary
                  ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 font-medium'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              Apps
              <span className="text-xs">{showAppsMenu ? '▲' : '▼'}</span>
            </button>
            {showAppsMenu && (
              <div className="absolute left-0 mt-2 w-40 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-lg py-1 z-50">
                {secondaryServices.map((service) => {
                  const isCurrent = service.name === currentService;
                  return (
                    <a
                      key={service.name}
                      href={service.href}
                      className={`block px-4 py-2 text-sm transition no-underline ${
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
            )}
          </div>
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
            <div className="flex items-center gap-2">
              {balance !== null && balance > 0 && (
                <span className="text-sm font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-2.5 py-1 rounded-full">
                  ${balance.toFixed(2)}
                </span>
              )}
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                <span className="text-xl">👤</span>
                <span className="text-sm font-medium">
                  {identity.tier === 'soft' && '⚡ '}
                  {identity.handle
                    ? `@${identity.handle}`
                    : identity.name
                    ? identity.name
                    : identity.did?.slice(0, 12) + '...'}
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
                    {unreadMessages > 0 && (
                      <span className="ml-auto bg-orange-500 text-white text-xs font-bold rounded-full px-2 py-0.5 min-w-[1.25rem] text-center">
                        {unreadMessages}
                      </span>
                    )}
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
          {allServices.map((service) => {
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
              <a href={userLinks.messages} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 no-underline">
                <span>💬 Messages</span>
                {unreadMessages > 0 && (
                  <span className="bg-orange-500 text-white text-xs font-bold rounded-full px-2 py-0.5 min-w-[1.25rem] text-center">
                    {unreadMessages}
                  </span>
                )}
              </a>
              <a href={userLinks.connections} className="block px-3 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 no-underline">🤝 Connections</a>
            </>
          )}
        </div>
      )}
    </nav>
  );
}
