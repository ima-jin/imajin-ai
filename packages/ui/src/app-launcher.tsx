'use client';

import React, { useState, useEffect, useRef } from 'react';

export interface LauncherService {
  name: string;
  description: string;
  icon: string;
  label: string;
  visibility: 'public' | 'authenticated' | 'creator' | 'internal';
  category: 'core' | 'creator' | 'developer' | 'infrastructure' | 'meta';
  url: string;
  externalUrl?: string;
}

export interface AppLauncherProps {
  registryUrl: string;
  currentService?: string;
  tier?: 'anonymous' | 'soft' | 'hard' | 'creator';
  /** Render inline (for mobile menu) instead of as a flyout */
  inline?: boolean;
}

/** Services that belong in the profile dropdown, not the launcher flyout */
const PROFILE_DROPDOWN_SERVICES = new Set(['connections', 'chat']);

function filterByTier(services: LauncherService[], tier: string): LauncherService[] {
  const hasProfile = tier === 'hard' || tier === 'creator';
  return services.filter((s) => {
    if (s.visibility === 'internal') return false;
    if (PROFILE_DROPDOWN_SERVICES.has(s.name)) return false;
    if (s.visibility === 'public') return true;
    if (s.visibility === 'authenticated') return hasProfile;
    if (s.visibility === 'creator') return hasProfile;
    return false;
  });
}

function groupByCategory(services: LauncherService[]): { core: LauncherService[]; creator: LauncherService[]; developer: LauncherService[]; meta: LauncherService[] } {
  return {
    core: services.filter((s) => s.category === 'core'),
    creator: services.filter((s) => s.category === 'creator'),
    developer: services.filter((s) => s.category === 'developer'),
    meta: services.filter((s) => s.category === 'meta'),
  };
}

export function AppLauncher({ registryUrl, currentService, tier = 'anonymous', inline = false }: AppLauncherProps) {
  const [services, setServices] = useState<LauncherService[]>([]);
  const [showPanel, setShowPanel] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`${registryUrl}/api/specs`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.services) setServices(data.services);
      })
      .catch(() => {});
  }, [registryUrl]);

  useEffect(() => {
    if (!showPanel) return;
    function handleClickOutside(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        setShowPanel(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showPanel]);

  const visible = filterByTier(services, tier);
  const { core, creator, developer, meta } = groupByCategory(visible);

  const wwwUrl = services.find((s) => s.name === 'www')?.url || '#';

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

  const content = (
    <>
      {core.length > 0 && (
        <div>
          {core.map(renderTile)}
        </div>
      )}
      {creator.length > 0 && (
        <div>
          <div className="px-3 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500">
            Creator Tools
          </div>
          {creator.map(renderTile)}
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
      <div className="border-t border-gray-200 dark:border-gray-800 mt-1 pt-1">
        <a
          href={`${wwwUrl}/apps`}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800 transition no-underline"
        >
          See all apps →
        </a>
      </div>
    </>
  );

  // Inline mode for mobile menu
  if (inline) {
    return <div className="space-y-0.5">{content}</div>;
  }

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setShowPanel(!showPanel)}
        className={`px-3 py-1.5 rounded-lg text-sm transition flex items-center gap-1.5 ${
          showPanel
            ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400'
            : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
        }`}
      >
        <span>🚀</span>
        <span className="hidden sm:inline">Launcher</span>
      </button>
      {showPanel && (
        <div className="absolute left-0 mt-2 w-56 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-xl py-2 z-50">
          {visible.length === 0 ? (
            <div className="px-4 py-3 text-sm text-gray-400">Loading...</div>
          ) : (
            content
          )}
        </div>
      )}
    </div>
  );
}
