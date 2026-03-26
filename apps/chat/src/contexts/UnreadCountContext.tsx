'use client';

import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';

interface UnreadCountContextValue {
  total: number;
}

const UnreadCountContext = createContext<UnreadCountContextValue>({ total: 0 });

export function UnreadCountProvider({ children }: { children: React.ReactNode }) {
  const [total, setTotal] = useState(0);
  const { lastMessage } = useWebSocket();

  const fetchUnreadCount = useCallback(async () => {
    try {
      const res = await fetch('/api/conversations/unread');
      if (res.ok) {
        const data = await res.json();
        setTotal(data.total || 0);
      }
    } catch {
      // Ignore errors
    }
  }, []);

  useEffect(() => {
    fetchUnreadCount();
    const interval = setInterval(fetchUnreadCount, 30000);
    const handleVisibilityChange = () => {
      if (!document.hidden) fetchUnreadCount();
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchUnreadCount]);

  useEffect(() => {
    if (lastMessage?.type === 'new_message') {
      fetchUnreadCount();
    }
  }, [lastMessage, fetchUnreadCount]);

  return (
    <UnreadCountContext.Provider value={{ total }}>
      {children}
    </UnreadCountContext.Provider>
  );
}

export function useUnreadCount() {
  return useContext(UnreadCountContext);
}
