'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useIdentities } from './use-identities';
import { loadLauncherServices, type LauncherService } from './launcher-services';
export type { LauncherService } from './launcher-services';

export interface AppLauncherProps {
  registryUrl: string;
  currentService?: string;
  tier?: 'anonymous' | 'soft' | 'hard' | 'creator';
  /** Render inline (for mobile menu) instead of as a flyout */
  inline?: boolean;
  /** Layout variant: 'list' (default) or 'grid' (4-column icon grid) */
  variant?: 'list' | 'grid';
  /** Auth service URL — enables identity switcher when provided */
  authUrl?: string;
  /** Group kernel-service gates (registry apps are already scoped by the API). */
  enabledServices?: string[];
  /** Session identity key; changing people must invalidate the previous app list. */
  identityDid?: string | null;
}

function filterByTier(services: LauncherService[], tier: string): LauncherService[] {
  const hasProfile = tier === 'hard' || tier === 'creator';
  return services.filter((s) => {
    if (s.visibility === 'internal') return false;
    if (s.visibility === 'public') return true;
    if (s.visibility === 'authenticated') return hasProfile;
    if (s.visibility === 'creator') return hasProfile;
    return false;
  });
}

function groupByCategory(services: LauncherService[]): { kernel: LauncherService[]; core: LauncherService[]; developer: LauncherService[]; meta: LauncherService[] } {
  return {
    kernel: services.filter((s) => s.category === 'kernel'),
    core: services.filter((s) => s.category === 'core' || s.category === 'creator'),
    developer: services.filter((s) => s.category === 'developer'),
    meta: services.filter((s) => s.category === 'meta'),
  };
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

export function AppLauncher({ registryUrl, currentService, tier = 'anonymous', inline = false, variant = 'list', authUrl, enabledServices, identityDid }: Readonly<AppLauncherProps>) {
  const [services, setServices] = useState<LauncherService[]>([]);
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [showPanel, setShowPanel] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const showIdentities = tier === 'hard' || tier === 'creator';
  // profileUrl=null: AppLauncher doesn't use identity config (enabledServices passed from parent)
  const { identities, activeIdentity, setActiveIdentity } = useIdentities(showIdentities && authUrl ? authUrl : null, null);

  useEffect(() => {
    const refresh = () => { setServices([]); setRevision((value) => value + 1); };
    globalThis.addEventListener('imajin:session-changed', refresh);
    globalThis.addEventListener('imajin:acting-as-changed', refresh);
    globalThis.addEventListener('imajin:apps-changed', refresh);
    return () => {
      globalThis.removeEventListener('imajin:session-changed', refresh);
      globalThis.removeEventListener('imajin:acting-as-changed', refresh);
      globalThis.removeEventListener('imajin:apps-changed', refresh);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setServices([]);
    setLoading(true);
    // Existing direct consumers need not pass authUrl: derive it from the
    // registry's node, never the standalone application's own origin.
    const authBase = authUrl ?? new URL('../auth', new URL(`${registryUrl}/`, globalThis.location.href)).href;
    void loadLauncherServices(registryUrl, authBase, tier !== 'anonymous').then((entries) => {
      if (!cancelled) {
        setServices(entries);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [registryUrl, authUrl, tier, activeIdentity, identityDid, revision]);

  useEffect(() => {
    if (!showPanel) return;
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node | null)) {
        setShowPanel(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPanel]);

  let visible = filterByTier(services, tier);
  if (activeIdentity) {
    visible = visible.filter((s) => !['pay', 'media'].includes(s.name) || enabledServices?.includes(s.name));
  }
  const { kernel, core, developer, meta } = groupByCategory(visible);

  const wwwUrl = services.find((s) => s.name === 'kernel')?.url ?? services.find((s) => s.name === 'www')?.url ?? '/';
  const directoryUrl = authUrl
    ? `${authUrl.replace(/\/$/, '')}/app-directory`
    : `${registryUrl.replace(/\/?registry\/?$/, '/auth')}/app-directory`;

  function renderTile(service: LauncherService) {
    const isCurrent = service.name === currentService;
    const isExternal = !!service.externalUrl;
    return (
      <a
        key={service.name}
        href={service.url}
        {...(isExternal && { target: '_blank', rel: 'noopener noreferrer' })}
        className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition no-underline ${
          isCurrent
            ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 font-medium'
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
        }`}
      >
        <span className="text-lg flex-shrink-0">{service.icon}</span>
        <span>{service.label}</span>
      </a>
    );
  }

  function renderGridTile(service: LauncherService) {
    const isCurrent = service.name === currentService;
    return (
      <a
        key={service.name}
        href={service.url}
        className={`flex flex-col items-center justify-center w-16 h-16 rounded-lg text-center transition no-underline ${
          isCurrent
            ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400'
            : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
        }`}
      >
        <span className="text-2xl">{service.icon}</span>
        <span className="text-[10px] mt-0.5 leading-tight">{service.label}</span>
      </a>
    );
  }

  const identitiesSection = showIdentities && (identities.length > 0 || authUrl) ? (
    <div className="border-t border-gray-200 dark:border-gray-800 mt-1 pt-1">
      <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
        Switch To
      </div>
      {identities.map((ident) => {
        const isActive = ident.groupDid === activeIdentity;
        return (
          <button type="button"
            key={ident.groupDid}
            onClick={() => { setActiveIdentity(isActive ? null : ident.groupDid); setShowPanel(false); }}
            className={`w-full text-left flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition ${
              isActive
                ? 'bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 font-medium'
                : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            <span className="text-lg flex-shrink-0">{scopeIcon(ident.scope)}</span>
            <span>{ident.name || ident.handle || ident.groupDid.slice(0, 12)}</span>
            {isActive && <span className="ml-auto text-amber-600 dark:text-amber-400 font-bold text-xs">✓</span>}
          </button>
        );
      })}
    </div>
  ) : null;

  const footer = (
    <div className="border-t border-gray-200 dark:border-gray-800 mt-1 pt-1">
      {tier !== 'anonymous' && (
        <a
          href={directoryUrl}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition no-underline"
        >
          Add app
        </a>
      )}
      <a
        href={wwwUrl || '/'}
        className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition no-underline"
      >
        See all apps →
      </a>
    </div>
  );

  const content = variant === 'grid' ? (
    <>
      {kernel.length > 0 && (
        <div>
          <div className="col-span-4 px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            Kernel Services
          </div>
          <div className="grid grid-cols-4 gap-1 px-2">
            {kernel.map(renderGridTile)}
          </div>
        </div>
      )}
      {core.length > 0 && (
        <div className="grid grid-cols-4 gap-1 px-2">
          {core.map(renderGridTile)}
        </div>
      )}
      {developer.length > 0 && (
        <div>
          <div className="col-span-4 px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            Developers
          </div>
          <div className="grid grid-cols-4 gap-1 px-2">
            {developer.map(renderGridTile)}
          </div>
        </div>
      )}
      {identitiesSection}
      {footer}
    </>
  ) : (
    <>
      {kernel.length > 0 && (
        <div>
          <div className="px-3 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            Kernel Services
          </div>
          {kernel.map(renderTile)}
        </div>
      )}
      {core.length > 0 && (
        <div>
          {core.map(renderTile)}
        </div>
      )}
      {developer.length > 0 && (
        <div>
          <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            Developers
          </div>
          {developer.map(renderTile)}
        </div>
      )}
      {meta.length > 0 && (
        <div>
          <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            Project
          </div>
          {meta.map(renderTile)}
        </div>
      )}
      {identitiesSection}
      {footer}
    </>
  );

  // Inline mode for mobile menu
  if (inline) {
    return <div className="space-y-0.5">{content}</div>;
  }
  const emptyMessage = loading ? 'Loading...' : 'No apps to show.';

  return (
    <div className="relative" ref={panelRef}>
      <button type="button"
        onClick={() => setShowPanel(!showPanel)}
        className={`px-3 py-1.5 rounded-lg text-sm transition flex items-center gap-1.5 ${
          showPanel
            ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400'
            : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
        }`}
      >
        {variant === 'grid' ? (
          <span className="grid grid-cols-2 gap-0.5 w-4 h-4">
            <span className="w-1.5 h-1.5 rounded-sm bg-current" />
            <span className="w-1.5 h-1.5 rounded-sm bg-current" />
            <span className="w-1.5 h-1.5 rounded-sm bg-current" />
            <span className="w-1.5 h-1.5 rounded-sm bg-current" />
          </span>
        ) : (
          <>
            <span>🚀</span>
            <span className="hidden sm:inline">Launcher</span>
          </>
        )}
      </button>
      {showPanel && (
        <div className={`absolute left-0 mt-2 ${variant === 'grid' ? 'w-72' : 'w-56'} bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-xl py-2 z-50`}>
          {visible.length === 0 ? (
            <>
              <div role="status" className="px-4 py-3 text-sm text-gray-400">
                {emptyMessage}
              </div>
              {footer}
            </>
          ) : (
            content
          )}
        </div>
      )}
    </div>
  );
}
