'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useIdentity, LoginPrompt } from '@/contexts/IdentityContext';
import { NewChatModal } from '@/app/components/NewChatModal';

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

  useEffect(() => {
    if (!identity) return;

    async function fetchConversations() {
      try {
        const res = await fetch('/api/conversations');
        if (!res.ok) throw new Error('Failed to load conversations');
        const data = await res.json();
        setConversations(data.conversations || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setLoadingConvs(false);
      }
    }
    fetchConversations();
  }, [identity]);

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
                <div
                  className={`w-12 h-12 rounded-full flex items-center justify-center text-lg font-semibold ${
                    conv.type === 'group'
                      ? 'bg-orange-100 dark:bg-orange-900/30 text-orange-600'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300'
                  }`}
                >
                  {conv.type === 'group' ? '👥' : '💬'}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between">
                    <span className="font-medium truncate text-gray-900 dark:text-white">
                      {conv.name || (conv.type === 'direct' && conv.otherParticipant
                        ? (conv.otherParticipant.name || (conv.otherParticipant.handle ? `@${conv.otherParticipant.handle}` : 'Direct Message'))
                        : 'Direct Message')}
                    </span>
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
