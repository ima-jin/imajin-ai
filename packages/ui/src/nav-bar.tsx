'use client';

import React, { useState, useEffect, useRef } from 'react';
import { AppLauncher } from './app-launcher';
import { NotificationBell } from './notification-bell';
import { getPort } from '@imajin/config';
import { useIdentities } from './use-identities';

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
  notify?: string;
}

export interface NavBarProps {
  currentService?: string;
  servicePrefix?: string;
  domain?: string;
  identity?: NavIdentity;
  unreadMessages?: number;
  serviceUrls?: ServiceUrls;
  children?: React.ReactNode;
}

function buildUrl(service: string, prefix: string, domain: string, overrides?: ServiceUrls) {
  const url = overrides?.[service as keyof ServiceUrls];
  if (url) return url;

  // Localhost-aware: use canonical port map instead of subdomain pattern
  if (domain.includes('localhost') || prefix.includes('localhost')) {
    const port = getPort(service, 'dev');
    return port ? `http://localhost:${port}` : `http://localhost:3000`;
  }

  // Single-domain mode: prefix is a full URL like "https://dev-jin.imajin.ai/"
  // Strip protocol and check for dots to detect
  const stripped = prefix.replace(/^https?:\/\//, '');
  if (stripped.includes('.')) {
    const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
    if (service === 'www' || service === 'kernel') return base;
    return `${base}/${service}`;
  }

  return `${prefix}${service}.${domain}`;
}

function scopeIcon(scope: string): string {
  if (scope === 'community') return '🏛️';
  if (scope === 'org') return '🏢';
  if (scope === 'family') return '👨‍👩‍👦';
  if (scope === 'node') return '🖥️';
  if (scope === 'agent') return '🤖';
  if (scope === 'device') return '📱';
  return '👤';
}

function buildUserLinks(prefix: string, domain: string, overrides?: ServiceUrls) {
  return {
    connections: buildUrl('connections', prefix, domain, overrides),
    messages: buildUrl('chat', prefix, domain, overrides),
    profile: buildUrl('profile', prefix, domain, overrides),
  };
}

/**
 * Map identity tier to launcher tier.
 */
function getLauncherTier(identity: NavIdentity | null): 'anonymous' | 'soft' | 'hard' | 'creator' {
  if (!identity?.isLoggedIn) return 'anonymous';
  if (identity.tier === 'soft') return 'soft';
  // TODO: distinguish creator from hard DID when roles are implemented
  return 'hard';
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
                onLogin: () => { window.location.href = `${authUrl}/login?next=${encodeURIComponent(window.location.href)}`; },
                onRegister: () => { window.location.href = `${authUrl}/register`; },
              });
            },
            onViewProfile: data.handle
              ? () => { window.location.href = `${profileUrl}/${data.handle}`; }
              : data.did
              ? () => { window.location.href = `${profileUrl}/${data.did}`; }
              : undefined,
            onEditProfile: () => { window.location.href = `${profileUrl}/edit`; },
            onLogin: () => { window.location.href = `${authUrl}/login?next=${encodeURIComponent(window.location.href)}`; },
            onRegister: () => { window.location.href = `${authUrl}/register`; },
          });
        } else {
          setIdentity({
            isLoggedIn: false,
            onLogin: () => { window.location.href = `${authUrl}/login?next=${encodeURIComponent(window.location.href)}`; },
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
  children,
}: NavBarProps) {
  const userLinks = buildUserLinks(servicePrefix, domain, serviceUrls);
  const isDev = servicePrefix.includes('dev-');
  const [showDropdown, setShowDropdown] = useState(false);
  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');

  useEffect(() => {
    const saved = typeof window !== 'undefined' ? localStorage.getItem('theme') : null;
    setTheme(saved === 'light' ? 'light' : 'dark');
  }, []);

  function toggleTheme() {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    localStorage.setItem('theme', next);
    if (next === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }

  // Auto-fetch identity if no prop provided
  const autoIdentity = useAutoIdentity(servicePrefix, domain, serviceUrls);
  const identity = identityProp ?? autoIdentity;

  const registryUrl = buildUrl('registry', servicePrefix, domain, serviceUrls);
  const launcherTier = getLauncherTier(identity);

  // Fetch balance from pay service (scope-aware, re-fetches on scope switch)
  const [cashBalance, setCashBalance] = useState<number | null>(null);
  const [mjnBalance, setMjnBalance] = useState<number | null>(null);
  const [scopeVersion, setScopeVersion] = useState(0);
  useEffect(() => {
    const handler = () => setScopeVersion(v => v + 1);
    window.addEventListener('imajin:acting-as-changed', handler);
    return () => window.removeEventListener('imajin:acting-as-changed', handler);
  }, []);
  useEffect(() => {
    if (!identity?.isLoggedIn || !identity?.did) { setCashBalance(null); setMjnBalance(null); return; }
    const actingAs = typeof window !== 'undefined' ? localStorage.getItem('imajin:acting-as') : null;
    const effectiveDid = actingAs || identity.did;
    const payUrl = buildUrl('pay', servicePrefix, domain, serviceUrls);
    fetch(`${payUrl}/api/balance/${encodeURIComponent(effectiveDid)}`, { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data) {
          setCashBalance(data.cashAmount != null ? parseFloat(data.cashAmount) : null);
          setMjnBalance(data.creditAmount != null ? parseFloat(data.creditAmount) : null);
        } else {
          setCashBalance(null);
          setMjnBalance(null);
        }
      })
      .catch(() => {});
  }, [identity?.isLoggedIn, identity?.did, servicePrefix, domain, serviceUrls, scopeVersion]);

  // Fetch unread message count from chat service
  const [unread, setUnread] = useState<number>(unreadMessages);
  useEffect(() => {
    if (!identity?.isLoggedIn || identity?.tier === 'soft') { setUnread(0); return; }
    const chatUrl = buildUrl('chat', servicePrefix, domain, serviceUrls);
    function fetchUnread() {
      fetch(`${chatUrl}/api/conversations/unread`, { credentials: 'include' })
        .then(r => r.ok ? r.json() : null)
        .then(data => { if (data?.total != null) setUnread(data.total); })
        .catch(() => {});
    }
    fetchUnread();
    const interval = setInterval(fetchUnread, 60_000); // poll every 60s
    return () => clearInterval(interval);
  }, [identity?.isLoggedIn, identity?.tier, servicePrefix, domain, serviceUrls]);

  // Identities (group identities)
  const authUrl = buildUrl('auth', servicePrefix, domain, serviceUrls);
  const profileUrl = buildUrl('profile', servicePrefix, domain, serviceUrls);
  const { identities, activeIdentity, activeConfig, setActiveIdentity } = useIdentities(
    identity?.isLoggedIn && identity?.tier !== 'soft' ? authUrl : null,
    identity?.isLoggedIn && identity?.tier !== 'soft' ? profileUrl : null
  );
  const activeIdentityData = identities.find((f) => f.groupDid === activeIdentity) ?? null;

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
    <nav className="w-full border-b border-gray-200 dark:border-gray-800 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm relative z-50">
      {isDev && (
        <div className="w-full bg-amber-500/90 text-black text-xs font-bold text-center py-1 tracking-wide">
          ⚠ DEVELOPMENT ENVIRONMENT
        </div>
      )}
      <div className="max-w-6xl mx-auto px-4 py-3 flex items-center gap-2">
        {/* Logo */}
        <a
          href={buildUrl('www', servicePrefix, domain, serviceUrls)}
          className="flex items-center hover:opacity-80 transition shrink-0"
        >
          <span className="w-8 h-8 rounded-lg bg-amber-500/10 dark:bg-amber-500/20 flex items-center justify-center">
            <span className="text-xl font-bold text-amber-500">人</span>
          </span>
        </a>

        {/* Children slot (center, fills available space) */}
        <div className="flex-1 min-w-0">{children}</div>

        {/* Right - Launcher + Quick Access (desktop) */}
        <div className="hidden sm:flex items-center gap-1">
          <AppLauncher
            registryUrl={registryUrl}
            currentService={currentService}
            tier={launcherTier}
            variant="grid"
            authUrl={identity?.isLoggedIn && identity?.tier !== 'soft' ? authUrl : undefined}
            enabledServices={activeConfig?.enabledServices}
          />
          {identity?.isLoggedIn && identity?.tier !== 'soft' && (
            <>
              <a
                href={userLinks.messages}
                className="relative p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition no-underline"
                title="Messages"
              >
                <span className="text-lg">💬</span>
                {unread > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 bg-orange-500 text-white text-[10px] font-bold rounded-full min-w-[1.1rem] h-[1.1rem] flex items-center justify-center px-1">
                    {unread > 99 ? '99+' : unread}
                  </span>
                )}
              </a>
              <a
                href={userLinks.connections}
                className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition no-underline"
                title="Connections"
              >
                <span className="text-lg">🤝</span>
              </a>
            </>
          )}
        </div>

        {/* Notification Bell (desktop) */}
        {process.env.NEXT_PUBLIC_NOTIFY_URL && (
          <div className="hidden sm:flex items-center">
            <NotificationBell />
          </div>
        )}

        {/* Mobile hamburger */}
        <button
          onClick={() => setShowMobileMenu(!showMobileMenu)}
          className="sm:hidden p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
        >
          <span className="text-xl">{showMobileMenu ? '✕' : '☰'}</span>
        </button>

        {/* Right - Auth Section */}
        <div className="flex items-center gap-2">
          {identity?.isLoggedIn && identity?.tier === 'soft' ? (
            /* Soft DID — just a logout button, no dropdown */
            <button
              onClick={() => identity.onLogout?.()}
              className="px-3 py-1.5 rounded-lg text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition"
            >
              Logout
            </button>
          ) : identity?.isLoggedIn ? (
            <div className="flex items-center gap-2">
              {(cashBalance !== null && cashBalance > 0) && (
                <a
                  href={buildUrl('pay', servicePrefix, domain, serviceUrls)}
                  className="text-sm font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/20 px-2.5 py-1 rounded-full hover:bg-green-100 dark:hover:bg-green-900/40 transition no-underline"
                >
                  ${cashBalance.toFixed(2)}
                </a>
              )}
              {(mjnBalance !== null && mjnBalance > 0) && (
                <a
                  href={buildUrl('pay', servicePrefix, domain, serviceUrls)}
                  className="text-sm font-medium text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-900/20 px-2.5 py-1 rounded-full hover:bg-amber-100 dark:hover:bg-amber-900/40 transition no-underline"
                >
                  人{Math.round(mjnBalance)}
                </a>
              )}
            <div className="relative" ref={dropdownRef}>
              <button
                onClick={() => setShowDropdown(!showDropdown)}
                className="flex items-center gap-2 px-3 py-1.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition"
              >
                <span className="text-xl">
                  {activeIdentityData ? scopeIcon(activeIdentityData.scope) : '👤'}
                </span>
                <span className="flex flex-col items-start" style={{ gap: '2px' }}>
                  {activeIdentityData && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400 font-medium leading-none">
                      acting as
                    </span>
                  )}
                  <span className="text-sm font-medium leading-none">
                    {activeIdentityData
                      ? (activeIdentityData.name || activeIdentityData.handle || 'Identity')
                      : identity.handle
                      ? `@${identity.handle}`
                      : identity.name
                      ? identity.name
                      : identity.did?.slice(0, 12) + '...'}
                  </span>
                </span>
              </button>

              {showDropdown && (
                <div className="absolute right-0 mt-2 w-52 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-lg py-1 z-50">
                  {identity.tier !== 'soft' && (
                    <>
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
                      <a
                        href={`${buildUrl('auth', servicePrefix, domain, serviceUrls)}/settings/security`}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2 no-underline text-inherit"
                      >
                        <span>🔒</span> Security
                      </a>
                      <a
                        href={`${buildUrl('notify', servicePrefix, domain, serviceUrls)}/settings`}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2 no-underline text-inherit"
                      >
                        <span>🔔</span> Notifications
                      </a>
                      <hr className="my-1 border-gray-200 dark:border-gray-800" />
                      <a
                        href={userLinks.messages}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2 no-underline text-inherit"
                      >
                        <span>💬</span> Messages
                        {unread > 0 && (
                          <span className="ml-auto bg-orange-500 text-white text-xs font-bold rounded-full px-2 py-0.5 min-w-[1.25rem] text-center">
                            {unread}
                          </span>
                        )}
                      </a>
                      <a
                        href={userLinks.connections}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2 no-underline text-inherit"
                      >
                        <span>🤝</span> Connections
                      </a>
                      <a
                        href={buildUrl('pay', servicePrefix, domain, serviceUrls)}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2 no-underline text-inherit"
                      >
                        <span>💰</span> Wallet
                      </a>
                      <a
                        href={buildUrl('media', servicePrefix, domain, serviceUrls)}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2 no-underline text-inherit"
                      >
                        <span>📁</span> Media
                      </a>
                      <a
                        href={buildUrl('auth', servicePrefix, domain, serviceUrls)}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2 no-underline text-inherit"
                      >
                        <span>🔑</span> Identities
                      </a>
                      <hr className="my-1 border-gray-200 dark:border-gray-800" />
                      <div className="px-4 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
                        Switch To
                      </div>
                      {activeIdentity && identity && (
                        <div className="flex items-center group/identity">
                          <button
                            onClick={() => {
                              setActiveIdentity(null);
                              setShowDropdown(false);
                            }}
                            className="flex-1 text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2"
                          >
                            <span>👤</span>
                            <span>
                              {identity.handle ? `@${identity.handle}` : identity.name || 'Personal'}
                            </span>
                          </button>
                        </div>
                      )}
                      {identities.slice(0, 5).map((ident) => {
                        const isActive = ident.groupDid === activeIdentity;
                        return (
                          <div key={ident.groupDid} className="flex items-center group/identity">
                            <button
                              onClick={() => {
                                setActiveIdentity(isActive ? null : ident.groupDid);
                                setShowDropdown(false);
                              }}
                              className="flex-1 text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2"
                            >
                              <span>{scopeIcon(ident.scope)}</span>
                              <span className={isActive ? 'font-medium' : ''}>
                                {ident.name || ident.handle || ident.groupDid.slice(0, 12)}
                              </span>
                              {isActive && (
                                <span className="ml-auto text-amber-600 dark:text-amber-400 font-bold text-xs">✓</span>
                              )}
                            </button>
                            <a
                              href={`${authUrl}/groups/${encodeURIComponent(ident.groupDid)}/settings`}
                              onClick={e => e.stopPropagation()}
                              className="pr-3 py-2 text-gray-400 dark:text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 transition opacity-0 group-hover/identity:opacity-100 no-underline text-sm"
                              title="Settings"
                            >
                              ⚙️
                            </a>
                          </div>
                        );
                      })}
                      {identities.length > 5 && (
                        <a
                          href={buildUrl('auth', servicePrefix, domain, serviceUrls)}
                          className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2 no-underline text-inherit text-gray-500 dark:text-gray-400"
                        >
                          View all →
                        </a>
                      )}
                      <hr className="my-1 border-gray-200 dark:border-gray-800" />
                      <button
                        onClick={toggleTheme}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2"
                      >
                        <span>{theme === 'dark' ? '☀️' : '🌙'}</span> {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
                      </button>
                      <a
                        href={`${buildUrl('www', servicePrefix, domain, serviceUrls)}/bugs`}
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-800 transition flex items-center gap-2 no-underline text-inherit"
                      >
                        <span>🐛</span> Report a Bug
                      </a>
                    </>
                  )}
                  {identity.onLogout && (
                    <>
                      {identity.tier !== 'soft' && <hr className="my-1 border-gray-200 dark:border-gray-800" />}
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
        <div className="sm:hidden border-t border-gray-200 dark:border-gray-800 px-4 py-3">
          {children && <div className="mb-3">{children}</div>}
          <AppLauncher
            registryUrl={registryUrl}
            currentService={currentService}
            tier={launcherTier}
            inline
            variant="grid"
            authUrl={identity?.isLoggedIn && identity?.tier !== 'soft' ? authUrl : undefined}
            enabledServices={activeConfig?.enabledServices}
          />
          {identity?.isLoggedIn && identity?.tier !== 'soft' && (
            <div className="flex items-center gap-2 mt-3 pt-3 border-t border-gray-200 dark:border-gray-800">
              <a
                href={userLinks.messages}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition no-underline text-sm text-inherit"
              >
                <span>💬</span> Messages
                {unread > 0 && (
                  <span className="bg-orange-500 text-white text-xs font-bold rounded-full px-2 py-0.5 min-w-[1.25rem] text-center">
                    {unread}
                  </span>
                )}
              </a>
              <a
                href={userLinks.connections}
                className="flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 transition no-underline text-sm text-inherit"
              >
                <span>🤝</span> Connections
              </a>
            </div>
          )}
        </div>
      )}
    </nav>
  );
}
