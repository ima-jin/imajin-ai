'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface EventChatButtonProps {
  eventId: string;
  chatUrl?: string;
}

export function EventChatButton({ eventId, chatUrl }: EventChatButtonProps) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [lobbyConversationId, setLobbyConversationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const baseChatUrl = chatUrl || (typeof window !== 'undefined'
    ? `${window.location.protocol}//${window.location.hostname.replace('events', 'chat')}`
    : 'https://chat.imajin.ai');

  useEffect(() => {
    async function checkAccess() {
      try {
        const res = await fetch(`/api/events/${eventId}/my-ticket`);
        if (res.ok) {
          const data = await res.json();
          if (data.hasTicket) {
            setConversationId(data.conversationId);
            setLobbyConversationId(data.lobbyConversationId);
          }
        }
      } catch (err) {
        console.error('Failed to check event access:', err);
      } finally {
        setLoading(false);
      }
    }
    checkAccess();
  }, [eventId]);

  if (loading || (!conversationId && !lobbyConversationId)) return null;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Event Lobby - Open to all ticket holders */}
      {lobbyConversationId && (
        <Link
          href={`/${eventId}/lobby`}
          className="px-6 py-4 bg-gradient-to-r from-orange-500 to-amber-600 text-white font-semibold rounded-xl hover:from-orange-600 hover:to-amber-700 transition shadow-lg flex flex-col items-center justify-center gap-2"
        >
          <span className="text-2xl">💬</span>
          <span>Event Lobby</span>
          <span className="text-xs opacity-90">Chat with all attendees</span>
        </Link>
      )}

      {/* Private Event Chat - Pod members only */}
      {conversationId && (
        <a
          href={`${baseChatUrl}/conversations/${conversationId}`}
          className="px-6 py-4 bg-gradient-to-r from-purple-500 to-indigo-600 text-white font-semibold rounded-xl hover:from-purple-600 hover:to-indigo-700 transition shadow-lg flex flex-col items-center justify-center gap-2"
        >
          <span className="text-2xl">🔒</span>
          <span>Private Chat</span>
          <span className="text-xs opacity-90">Encrypted group chat</span>
        </a>
      )}
    </div>
  );
}
