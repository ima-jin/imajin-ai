'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useIdentity, LoginPrompt } from '@/contexts/IdentityContext';
import { NewChatModal } from '@/app/components/NewChatModal';
import { useWebSocket } from '@/hooks/useWebSocket';

interface V1Conversation {
  id: string;
  type: string;
  name: string | null;
  createdBy: string;
  lastMessageAt: string | null;
  createdAt: string;
  myRole: string;
  otherParticipant?: {
    did: string;
    handle: string | null;
    name: string | null;
  } | null;
  podName?: string | null;
  eventName?: string | null;
  participantCount?: number;
  unread?: number;
}

interface V2Conversation {
  did: string;
  name: string | null;
  type: 'dm' | 'group' | 'event' | 'unknown';
  slug?: string;
  createdBy: string;
  createdAt: string;
  lastMessageAt: string | null;
  lastMessagePreview: string;
  unread: number;
}

interface DisplayConversation {
  key: string;
  href: string;
  name: string;
  type: string;
  lastMessageAt: string | null;
  createdAt: string;
  unread: number;
  subtitle: string;
  otherParticipantDid?: string;
}

function formatTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'now';
  if (diffMins < 60) return `${diffMins}m`;
  if (diffHours < 24) return `${diffHours}h`;
  if (diffDays < 7) return `${diffDays}d`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function v2DisplayName(conv: V2Conversation): string {
  if (
    conv.name &&
    !conv.name.startsWith('did:') &&   // skip raw DID stored as name (legacy)
    !conv.name.startsWith('dm:') &&
    !conv.name.startsWith('group:') &&
    !conv.name.startsWith('event:') &&
    !conv.name.startsWith('evt_')
  ) {
    return conv.name;
  }
  if (conv.type === 'dm') return 'Direct Message';
  if (conv.type === 'event') {
    if (conv.slug) return `Event: ${conv.slug}`;
    // Legacy: name was stored as the raw DID (did:imajin:evt_xxx)
    if (conv.name?.startsWith('did:imajin:evt_')) return `Event: ${conv.name.slice('did:imajin:'.length)}`;
    return 'Event Chat';
  }
  if (conv.type === 'group') return 'Group Chat';
  return 'Conversation';
}

export default function ConversationsPage() {
  const { identity, loading } = useIdentity();
  const [v1Conversations, setV1Conversations] = useState<V1Conversation[]>([]);
  const [v2Conversations, setV2Conversations] = useState<V2Conversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNewChat, setShowNewChat] = useState(false);
  const [onlineStatus, setOnlineStatus] = useState<Record<string, boolean>>({});
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const { lastMessage } = useWebSocket();

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchConversations = useCallback(async () => {
    if (!identity) return;

    try {
      const [convsRes, unreadRes, v2Res] = await Promise.all([
        fetch('/api/conversations'),
        fetch('/api/conversations/unread'),
        fetch('/api/conversations-v2'),
      ]);

      if (convsRes.status === 401) {
        window.location.reload();
        return;
      }
      if (!convsRes.ok) throw new Error('Failed to load conversations');

      const convsData = await convsRes.json();
      let convs: V1Conversation[] = convsData.conversations || [];

      if (unreadRes.ok) {
        const unreadData = await unreadRes.json();
        const unreadMap = new Map(
          unreadData.conversations.map((c: { id: string; unread: number }) => [c.id, c.unread])
        );
        convs = convs.map((conv) => ({ ...conv, unread: (unreadMap.get(conv.id) as number | undefined) ?? undefined }));
        convs.sort((a, b) => {
          if (a.unread && !b.unread) return -1;
          if (!a.unread && b.unread) return 1;
          return (
            new Date(b.lastMessageAt || b.createdAt).getTime() -
            new Date(a.lastMessageAt || a.createdAt).getTime()
          );
        });
      }

      setV1Conversations(convs);

      if (v2Res.ok) {
        const v2Data = await v2Res.json();
        setV2Conversations(v2Data.conversations || []);
      }

      // Fetch online status for v1 DMs
      const profileUrl = process.env.NEXT_PUBLIC_PROFILE_URL || 'http://localhost:3005';
      const didsToCheck = new Set<string>();
      convs.forEach((conv) => {
        if (conv.type === 'direct' && conv.otherParticipant?.did) {
          didsToCheck.add(conv.otherParticipant.did);
        }
      });
      for (const did of Array.from(didsToCheck)) {
        try {
          const presenceRes = await fetch(`${profileUrl}/api/presence/${encodeURIComponent(did)}`);
          if (presenceRes.ok) {
            const presenceData = await presenceRes.json();
            setOnlineStatus((prev) => ({ ...prev, [did]: presenceData.online }));
          }
        } catch {
          // Ignore presence errors
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoadingConvs(false);
    }
  }, [identity]);

  useEffect(() => {
    fetchConversations();
  }, [fetchConversations]);

  useEffect(() => {
    if (lastMessage?.type === 'new_message') fetchConversations();
  }, [lastMessage, fetchConversations]);

  useEffect(() => {
    if (!lastMessage || lastMessage.type !== 'user_presence') return;
    setOnlineStatus((prev) => ({ ...prev, [lastMessage.did]: lastMessage.online }));
  }, [lastMessage]);

  // Build unified display list
  const allConversations = useMemo((): DisplayConversation[] => {
    const items: DisplayConversation[] = [];

    // V2 DID-based conversations
    for (const conv of v2Conversations) {
      const name = v2DisplayName(conv);
      const subtitle = conv.lastMessagePreview || (
        conv.type === 'dm' ? 'Direct message' :
        conv.type === 'event' ? 'Event chat' :
        'Group chat'
      );

      items.push({
        key: `v2-${conv.did}`,
        href: `/conversations/${encodeURIComponent(conv.did)}`,
        name,
        type: conv.type,
        lastMessageAt: conv.lastMessageAt,
        createdAt: conv.createdAt,
        unread: conv.unread,
        subtitle,
      });
    }

    // V1 legacy conversations
    for (const conv of v1Conversations) {
      const name =
        conv.name ||
        (conv.type === 'direct' && conv.otherParticipant
          ? conv.otherParticipant.name ||
            (conv.otherParticipant.handle
              ? `@${conv.otherParticipant.handle}`
              : 'Direct Message')
          : 'Direct Message');

      const subtitle =
        conv.type === 'group'
          ? conv.eventName
            ? `Event: ${conv.eventName}`
            : conv.podName
            ? `Pod: ${conv.podName}`
            : conv.participantCount
            ? `${conv.participantCount} members`
            : 'Group chat'
          : conv.otherParticipant?.handle
          ? `@${conv.otherParticipant.handle}`
          : 'Direct message';

      items.push({
        key: `v1-${conv.id}`,
        href: `/conversations/${conv.id}`,
        name,
        type: conv.type === 'direct' ? 'dm' : conv.type,
        lastMessageAt: conv.lastMessageAt,
        createdAt: conv.createdAt,
        unread: conv.unread ?? 0,
        subtitle,
        otherParticipantDid: conv.otherParticipant?.did,
      });
    }

    // Sort: unread first, then by last message time
    items.sort((a, b) => {
      if (a.unread && !b.unread) return -1;
      if (!a.unread && b.unread) return 1;
      return (
        new Date(b.lastMessageAt || b.createdAt).getTime() -
        new Date(a.lastMessageAt || a.createdAt).getTime()
      );
    });

    return items;
  }, [v1Conversations, v2Conversations]);

  // Filter by search
  const filteredConversations = useMemo(() => {
    if (!debouncedSearch.trim()) return allConversations;
    const q = debouncedSearch.toLowerCase();
    return allConversations.filter(
      (c) => c.name.toLowerCase().includes(q) || c.subtitle.toLowerCase().includes(q)
    );
  }, [allConversations, debouncedSearch]);

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto mt-20 text-center text-gray-500">Loading...</div>
    );
  }

  if (!identity) return <LoginPrompt />;

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Messages</h1>
        <button
          onClick={() => setShowNewChat(true)}
          className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition text-sm font-medium"
        >
          New Chat
        </button>
      </div>

      {/* Search bar */}
      <div className="mb-4">
        <input
          type="search"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search conversations…"
          className="w-full px-4 py-2 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 text-sm outline-none focus:ring-2 focus:ring-orange-500/40 focus:border-orange-500"
        />
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg overflow-hidden">
        {loadingConvs ? (
          <div className="p-8 text-center text-gray-500">Loading conversations...</div>
        ) : filteredConversations.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            {debouncedSearch ? (
              <p>No conversations match &ldquo;{debouncedSearch}&rdquo;.</p>
            ) : (
              <>
                <p className="mb-4">No conversations yet.</p>
                <button
                  onClick={() => setShowNewChat(true)}
                  className="text-orange-500 hover:underline"
                >
                  Start a new chat
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {filteredConversations.map((conv) => (
              <ConversationRow
                key={conv.key}
                conv={conv}
                onlineStatus={onlineStatus}
              />
            ))}
          </div>
        )}
      </div>

      <p className="text-center text-sm text-gray-500 mt-6">
        🔒 All messages are end-to-end encrypted
      </p>

      {showNewChat && <NewChatModal onClose={() => setShowNewChat(false)} />}
    </div>
  );
}

function ConversationRow({
  conv,
  onlineStatus,
}: {
  conv: DisplayConversation;
  onlineStatus: Record<string, boolean>;
}) {
  const isGroup = conv.type === 'group';
  const isEvent = conv.type === 'event';
  const isDm = conv.type === 'dm' || conv.type === 'direct';

  const iconBg = isGroup
    ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600'
    : isEvent
    ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600'
    : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300';

  const icon = isGroup ? '👥' : isEvent ? '📅' : '💬';
  const isOnline = isDm && conv.otherParticipantDid
    ? onlineStatus[conv.otherParticipantDid] === true
    : false;

  return (
    <Link
      href={conv.href}
      className="flex items-center gap-4 p-4 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
    >
      <div className="relative flex-shrink-0">
        <div
          className={`w-12 h-12 rounded-full flex items-center justify-center text-lg font-semibold ${iconBg}`}
        >
          {icon}
        </div>
        {isOnline && (
          <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-white dark:border-gray-800" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span
              className={`truncate text-gray-900 dark:text-white ${
                conv.unread ? 'font-bold' : 'font-medium'
              }`}
            >
              {conv.name}
            </span>
            {conv.unread > 0 && (
              <span className="flex-shrink-0 bg-orange-500 text-white text-xs font-bold rounded-full px-2 py-0.5 min-w-[1.25rem] text-center">
                {conv.unread}
              </span>
            )}
          </div>
          <span className="text-xs text-gray-500 ml-2 flex-shrink-0">
            {formatTime(conv.lastMessageAt || conv.createdAt)}
          </span>
        </div>
        <p className="text-sm text-gray-500 truncate mt-1">{conv.subtitle}</p>
      </div>
    </Link>
  );
}
