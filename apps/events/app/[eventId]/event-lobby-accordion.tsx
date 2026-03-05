'use client';

import { useState, useEffect, useCallback } from 'react';
import { EventChat } from './components/EventChat';

interface EventLobbyAccordionProps {
  eventId: string;
}

export function EventLobbyAccordion({ eventId }: EventLobbyAccordionProps) {
  const [hasTicket, setHasTicket] = useState<boolean | null>(null);
  const [lobbyConversationId, setLobbyConversationId] = useState<string | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const CHAT_SERVICE_URL = process.env.NEXT_PUBLIC_CHAT_URL || 'http://localhost:3007';

  // Check ticket ownership on mount
  useEffect(() => {
    async function checkTicket() {
      try {
        const res = await fetch(`/api/events/${eventId}/my-ticket`);
        if (res.ok) {
          const data = await res.json();
          if (data.hasTicket) {
            setHasTicket(true);
            setLobbyConversationId(data.lobbyConversationId);
          } else {
            setHasTicket(false);
          }
        } else {
          setHasTicket(false);
        }
      } catch {
        setHasTicket(false);
      }
    }
    checkTicket();
  }, [eventId]);

  // Fetch unread count when collapsed
  const fetchUnreadCount = useCallback(async () => {
    if (!lobbyConversationId || isExpanded) return;

    try {
      const res = await fetch(`${CHAT_SERVICE_URL}/api/conversations/unread`, {
        credentials: 'include',
      });

      if (res.ok) {
        const data = await res.json();
        const conversation = data.conversations?.find((c: { id: string }) => c.id === lobbyConversationId);
        setUnreadCount(conversation?.unread || 0);
      }
    } catch (err) {
      console.error('Failed to fetch unread count:', err);
    }
  }, [lobbyConversationId, isExpanded, CHAT_SERVICE_URL]);

  // Poll for unread count when collapsed
  useEffect(() => {
    if (isExpanded || !hasTicket || !lobbyConversationId) return;
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 3000);
    return () => clearInterval(interval);
  }, [fetchUnreadCount, isExpanded, hasTicket, lobbyConversationId]);

  // Render nothing if no ticket or not authenticated
  if (hasTicket === false || hasTicket === null) {
    return null;
  }

  return (
    <div className="bg-white dark:bg-gray-800/50 backdrop-blur-sm rounded-2xl shadow-lg overflow-hidden">
      {/* Collapsed Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-800/80 transition"
      >
        <div className="flex items-center gap-3">
          <span className="text-2xl">💬</span>
          <span className="font-semibold text-lg">Event Chat</span>
        </div>
        <div className="flex items-center gap-3">
          {!isExpanded && unreadCount > 0 && (
            <span className="px-3 py-1 bg-orange-500 text-white text-xs font-semibold rounded-full">
              {unreadCount}
            </span>
          )}
          <span className={`text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
            ▼
          </span>
        </div>
      </button>

      {/* Expanded Chat */}
      {isExpanded && (
        <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4">
          <EventChat eventId={eventId} compact />
        </div>
      )}
    </div>
  );
}
