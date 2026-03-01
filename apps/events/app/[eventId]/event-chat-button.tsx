'use client';

import { useState, useEffect } from 'react';

interface EventChatButtonProps {
  eventId: string;
  chatUrl?: string;
}

export function EventChatButton({ eventId, chatUrl }: EventChatButtonProps) {
  const [conversationId, setConversationId] = useState<string | null>(null);
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
          if (data.hasTicket && data.conversationId) {
            setConversationId(data.conversationId);
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

  if (loading || !conversationId) return null;

  return (
    <a
      href={`${baseChatUrl}/conversations/${conversationId}`}
      className="w-full px-6 py-3 bg-gradient-to-r from-orange-500 to-amber-600 text-white font-semibold rounded-xl hover:from-orange-600 hover:to-amber-700 transition shadow-lg flex items-center justify-center gap-2"
    >
      <span>💬</span>
      <span>Event Chat</span>
    </a>
  );
}
