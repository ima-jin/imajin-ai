'use client';

import { useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';

export function UnreadTitleManager() {
  const [unreadCount, setUnreadCount] = useState(0);
  const [isVisible, setIsVisible] = useState(true);
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

    // Listen for visibility changes
    const handleVisibilityChange = () => {
      setIsVisible(!document.hidden);
      if (!document.hidden) {
        // When tab becomes visible, fetch latest count
        fetchUnreadCount();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchUnreadCount]);

  // Refetch when new message arrives via WebSocket
  useEffect(() => {
    if (lastMessage?.type === 'new_message') {
      fetchUnreadCount();
    }
  }, [lastMessage, fetchUnreadCount]);

  useEffect(() => {
    const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX?.includes('dev-')
      ? ' [DEV]'
      : '';

    if (!isVisible && unreadCount > 0) {
      document.title = `(${unreadCount}) Imajin Chat${prefix}`;
    } else {
      document.title = `Imajin Chat${prefix}`;
    }
  }, [unreadCount, isVisible]);

  return null;
}
