'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useIdentity, LoginPrompt } from '@/contexts/IdentityContext';
import { NewChatModal } from '@/app/components/NewChatModal';
import { useWebSocket } from '@/hooks/useWebSocket';

interface Conversation {
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

export default function ConversationsPage() {
  const { identity, loading } = useIdentity();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showNewChat, setShowNewChat] = useState(false);
  const [onlineStatus, setOnlineStatus] = useState<Record<string, boolean>>({});
  const { lastMessage } = useWebSocket();

  const fetchConversations = useCallback(async () => {
    if (!identity) return;

    try {
      const [convsRes, unreadRes] = await Promise.all([
        fetch('/api/conversations'),
        fetch('/api/conversations/unread'),
      ]);

      if (convsRes.status === 401) {
        // Session expired — force reload to trigger login prompt
        window.location.reload();
        return;
      }
      if (!convsRes.ok) throw new Error('Failed to load conversations');

      const convsData = await convsRes.json();
      let convs = convsData.conversations || [];

      // Add unread counts if available
      if (unreadRes.ok) {
        const unreadData = await unreadRes.json();
        const unreadMap = new Map(
          unreadData.conversations.map((c: { id: string; unread: number }) => [
            c.id,
            c.unread,
          ])
        );
        convs = convs.map((conv: Conversation) => ({
          ...conv,
          unread: unreadMap.get(conv.id) ?? undefined,
        }));

        // Sort unread conversations to the top
        convs.sort((a: Conversation, b: Conversation) => {
          if (a.unread && !b.unread) return -1;
          if (!a.unread && b.unread) return 1;
          // Both unread or both read - sort by last message time
          const aTime = new Date(a.lastMessageAt || a.createdAt).getTime();
          const bTime = new Date(b.lastMessageAt || b.createdAt).getTime();
          return bTime - aTime;
        });
      }

      setConversations(convs);

      // Fetch online status for all participants
      const didsToCheck = new Set<string>();
      convs.forEach((conv: Conversation) => {
        if (conv.type === 'direct' && conv.otherParticipant?.did) {
          didsToCheck.add(conv.otherParticipant.did);
        }
      });

      // Fetch presence for each DID
      const profileUrl = process.env.NEXT_PUBLIC_PROFILE_URL || 'http://localhost:3004';
      for (const did of Array.from(didsToCheck)) {
        try {
          const presenceRes = await fetch(`${profileUrl}/api/presence/${encodeURIComponent(did)}`);
          if (presenceRes.ok) {
            const presenceData = await presenceRes.json();
            setOnlineStatus(prev => ({ ...prev, [did]: presenceData.online }));
          }
        } catch {
          // Ignore presence fetch errors
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

  // Refetch when new message arrives via WebSocket
  useEffect(() => {
    if (lastMessage?.type === 'new_message') {
      fetchConversations();
    }
  }, [lastMessage, fetchConversations]);

  // Handle presence updates from WebSocket
  useEffect(() => {
    if (!lastMessage || lastMessage.type !== 'user_presence') return;
    setOnlineStatus(prev => ({
      ...prev,
      [lastMessage.did]: lastMessage.online,
    }));
  }, [lastMessage]);

  if (loading) {
    return (
      <div className="max-w-2xl mx-auto mt-20 text-center text-gray-500">
        Loading...
      </div>
    );
  }

  if (!identity) return <LoginPrompt />;

  return (
    <div className="max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Messages</h1>
        <button
          onClick={() => setShowNewChat(true)}
          className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 transition text-sm font-medium"
        >
          New Chat
        </button>
      </div>

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">
          {error}
        </div>
      )}

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg overflow-hidden">
        {loadingConvs ? (
          <div className="p-8 text-center text-gray-500">Loading conversations...</div>
        ) : conversations.length === 0 ? (
          <div className="p-8 text-center text-gray-500">
            <p className="mb-4">No conversations yet.</p>
            <button
              onClick={() => setShowNewChat(true)}
              className="text-orange-500 hover:underline"
            >
              Start a new chat
            </button>
          </div>
        ) : (
          <div className="divide-y divide-gray-100 dark:divide-gray-700">
            {conversations.map((conv) => (
              <Link
                key={conv.id}
                href={`/conversations/${conv.id}`}
                className="flex items-center gap-4 p-4 hover:bg-gray-50 dark:hover:bg-gray-700 transition"
              >
                {/* Avatar */}
                <div className="relative">
                  <div
                    className={`w-12 h-12 rounded-full flex items-center justify-center text-lg font-semibold ${
                      conv.type === 'group'
                        ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600'
                        : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                    }`}
                  >
                    {conv.type === 'group' ? '👥' : '💬'}
                  </div>
                  {/* Online indicator for direct messages */}
                  {conv.type === 'direct' && conv.otherParticipant?.did && onlineStatus[conv.otherParticipant.did] && (
                    <div className="absolute bottom-0 right-0 w-3 h-3 bg-green-500 rounded-full border-2 border-white dark:border-gray-800" />
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`truncate text-gray-900 dark:text-white ${conv.unread ? 'font-bold' : 'font-medium'}`}>
                        {conv.name || (conv.type === 'direct' && conv.otherParticipant
                          ? (conv.otherParticipant.name || (conv.otherParticipant.handle ? `@${conv.otherParticipant.handle}` : 'Direct Message'))
                          : 'Direct Message')}
                      </span>
                      {conv.unread && conv.unread > 0 && (
                        <span className="flex-shrink-0 bg-orange-500 text-white text-xs font-bold rounded-full px-2 py-0.5 min-w-[1.25rem] text-center">
                          {conv.unread}
                        </span>
                      )}
                    </div>
                    <span className="text-xs text-gray-500 ml-2 flex-shrink-0">
                      {formatTime(conv.lastMessageAt || conv.createdAt)}
                    </span>
                  </div>
                  <p className="text-sm text-gray-500 truncate mt-1">
                    {conv.type === 'group'
                      ? (conv.eventName
                          ? `Event: ${conv.eventName}`
                          : conv.podName
                            ? `Pod: ${conv.podName}`
                            : conv.participantCount
                              ? `${conv.participantCount} members`
                              : 'Group chat')
                      : conv.otherParticipant?.handle
                        ? `@${conv.otherParticipant.handle}`
                        : 'Direct message'}
                  </p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      {/* Encryption notice */}
      <p className="text-center text-sm text-gray-500 mt-6">
        🔒 All messages are end-to-end encrypted
      </p>

      {showNewChat && (
        <NewChatModal onClose={() => setShowNewChat(false)} />
      )}
    </div>
  );
}
