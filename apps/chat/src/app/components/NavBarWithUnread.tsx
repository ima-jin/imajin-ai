'use client';

import { useEffect, useState, useCallback } from 'react';
import { NavBar } from '@imajin/ui';
import { useWebSocket } from '@/hooks/useWebSocket';

export function NavBarWithUnread() {
  const [unreadCount, setUnreadCount] = useState(0);
  const { lastMessage } = useWebSocket();

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations/unread');
      if (res.ok) {
        const data = await res.json();
        setUnreadCount(data.total || 0);
      }
    } catch {
      // Ignore errors
    }
  }, []);

  useEffect(() => {
    // Initial fetch
    fetchUnreadCount();

    // Poll for updates every 30 seconds
    const interval = setInterval(fetchUnreadCount, 30000);

    return () => clearInterval(interval);
  }, [fetchUnreadCount]);

  // Refetch when new message arrives via WebSocket
  useEffect(() => {
    if (lastMessage?.type === 'new_message') {
      fetchUnreadCount();
    }
  }, [lastMessage, fetchUnreadCount]);

  return <NavBar currentService="Chat" unreadMessages={unreadCount} />;
}
