'use client';

import { useState, useEffect } from 'react';

export type CommunityTab = 'overview' | 'events' | 'chat' | 'members' | 'market';

interface CommunityTabsProps {
  tabs: { id: CommunityTab; label: string; icon: string; memberOnly?: boolean }[];
  activeTab: CommunityTab;
  onTabChange: (tab: CommunityTab) => void;
  isMember: boolean;
}

export function CommunityTabs({ tabs, activeTab, onTabChange, isMember }: Readonly<CommunityTabsProps>) {
  // Read initial tab from URL hash on mount
  useEffect(() => {
    const hash = globalThis.location.hash.slice(1) as CommunityTab;
    if (hash && tabs.some(t => t.id === hash)) {
      if (tabs.find(t => t.id === hash)?.memberOnly && !isMember) return;
      onTabChange(hash);
    }
  }, []);

  // Update hash when tab changes
  const handleTabChange = (tab: CommunityTab) => {
    globalThis.history.replaceState(null, '', `#${tab}`);
    onTabChange(tab);
  };

  return (
    <div className="flex gap-1 border-b border-zinc-800 mb-6 overflow-x-auto">
      {tabs.map(tab => {
        const disabled = tab.memberOnly && !isMember;
        return (
          <button
            key={tab.id}
            onClick={() => !disabled && handleTabChange(tab.id)}
            disabled={disabled}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 ${
              activeTab === tab.id
                ? 'border-orange-500 text-orange-400'
                : disabled
                ? 'border-transparent text-zinc-600 cursor-not-allowed'
                : 'border-transparent text-zinc-400 hover:text-zinc-200 hover:border-zinc-600'
            }`}
            title={disabled ? 'Join to access' : undefined}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
            {disabled && <span className="text-xs">🔒</span>}
          </button>
        );
      })}
    </div>
  );
}
