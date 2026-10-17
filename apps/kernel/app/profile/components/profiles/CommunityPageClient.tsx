'use client';

import { useState } from 'react';
import { CommunityTabs, type CommunityTab } from '../CommunityTabs';
import { CommunityChat } from '../CommunityChat';

interface CommunityPageClientProps {
  // Tab config
  enabledTabs: { id: string; label: string; icon: string; memberOnly?: boolean }[];
  isMember: boolean;

  // Content passed from server
  overviewContent: React.ReactNode;
  widgetContents: { id: string; content: React.ReactNode }[];
  membersContent: React.ReactNode;

  // Chat
  communityDid: string;
}

export function CommunityPageClient({
  enabledTabs,
  isMember,
  overviewContent,
  widgetContents,
  membersContent,
  communityDid,
}: Readonly<CommunityPageClientProps>) {
  const [activeTab, setActiveTab] = useState<CommunityTab>('overview');

  const tabs = enabledTabs;

  return (
    <>
      <CommunityTabs
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isMember={isMember}
      />

      {activeTab === 'overview' && overviewContent}
      {widgetContents.find((widget) => widget.id === activeTab)?.content}
      {activeTab === 'chat' && isMember && <CommunityChat communityDid={communityDid} />}
      {activeTab === 'members' && membersContent}
    </>
  );
}
