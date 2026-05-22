'use client';

import { useState } from 'react';
import { CommunityTabs, type CommunityTab } from '../CommunityTabs';
import { CommunityChat } from '../CommunityChat';

interface CommunityPageClientProps {
  // Tab config
  enabledTabs: CommunityTab[];
  isMember: boolean;

  // Content passed from server
  overviewContent: React.ReactNode;
  eventsContent: React.ReactNode;
  membersContent: React.ReactNode;
  marketContent: React.ReactNode | null;

  // Chat
  communityDid: string;
}

const TAB_CONFIG: Record<CommunityTab, { label: string; icon: string; memberOnly?: boolean }> = {
  overview: { label: 'Overview', icon: '🏠' },
  events: { label: 'Events', icon: '🎟' },
  chat: { label: 'Chat', icon: '💬', memberOnly: true },
  members: { label: 'Members', icon: '👥' },
  market: { label: 'Market', icon: '🛍' },
};

export function CommunityPageClient({
  enabledTabs,
  isMember,
  overviewContent,
  eventsContent,
  membersContent,
  marketContent,
  communityDid,
}: Readonly<CommunityPageClientProps>) {
  const [activeTab, setActiveTab] = useState<CommunityTab>('overview');

  const tabs = enabledTabs.map(id => ({ id, ...TAB_CONFIG[id] }));

  return (
    <>
      <CommunityTabs
        tabs={tabs}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        isMember={isMember}
      />

      {activeTab === 'overview' && overviewContent}
      {activeTab === 'events' && eventsContent}
      {activeTab === 'chat' && isMember && <CommunityChat communityDid={communityDid} />}
      {activeTab === 'members' && membersContent}
      {activeTab === 'market' && marketContent}
    </>
  );
}
