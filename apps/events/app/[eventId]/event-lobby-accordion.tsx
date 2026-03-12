'use client';

import { useState, useEffect, useCallback } from 'react';
import { ChatProvider, useChatWebSocket } from '@imajin/chat';
import { EventChat } from './components/EventChat';

const CHAT_URL = process.env.NEXT_PUBLIC_CHAT_URL || 'http://localhost:3007';
const AUTH_URL = process.env.NEXT_PUBLIC_AUTH_URL || 'http://localhost:3002';
const INPUT_URL = process.env.NEXT_PUBLIC_INPUT_URL || 'http://localhost:3008';

interface AccordionContentProps {
  eventId: string;
  eventDid: string;
  isExpanded: boolean;
  onUnreadChange: React.Dispatch<React.SetStateAction<number>>;
}

function AccordionContent({ eventId, eventDid, isExpanded, onUnreadChange }: AccordionContentProps) {
  const { lastMessage } = useChatWebSocket(eventDid);

  // Increment unread count when a new message arrives while collapsed
  useEffect(() => {
    if (!lastMessage || isExpanded) return;
    if (lastMessage.type === 'new_message') {
      onUnreadChange(prev => prev + 1);
    }
  }, [lastMessage, isExpanded, onUnreadChange]);

  // Reset unread when expanded
  useEffect(() => {
    if (isExpanded) onUnreadChange(0);
  }, [isExpanded, onUnreadChange]);

  if (!isExpanded) return null;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 px-6 py-4">
      <EventChat did={eventDid} eventId={eventId} compact />
    </div>
  );
}

interface EventLobbyAccordionProps {
  eventId: string;
  eventDid: string;
}

export function EventLobbyAccordion({ eventId, eventDid }: EventLobbyAccordionProps) {
  const [hasAccess, setHasAccess] = useState<boolean | null>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  // Check event access on mount (ticket holder OR organizer)
  useEffect(() => {
    async function checkAccess() {
      try {
        const res = await fetch(`/api/events/${eventId}/my-ticket`);
        if (res.ok) {
          const data = await res.json();
          setHasAccess(data.hasAccess || data.hasTicket || false);
        } else {
          setHasAccess(false);
        }
      } catch {
        setHasAccess(false);
      }
    }
    checkAccess();
  }, [eventId]);

  const handleUnreadChange = useCallback<React.Dispatch<React.SetStateAction<number>>>(
    (action) => setUnreadCount(action),
    []
  );

  // Render nothing if no access or not authenticated
  if (hasAccess === false || hasAccess === null) {
    return null;
  }

  return (
    <ChatProvider chatUrl={CHAT_URL} authUrl={AUTH_URL} inputUrl={INPUT_URL}>
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

        <AccordionContent
          eventId={eventId}
          eventDid={eventDid}
          isExpanded={isExpanded}
          onUnreadChange={handleUnreadChange}
        />
      </div>
    </ChatProvider>
  );
}
