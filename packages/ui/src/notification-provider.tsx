'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { useToast } from './toast';

export interface Notification {
  id: string;
  title: string;
  body?: string;
  urgency?: 'normal' | 'urgent';
  read: boolean;
  createdAt: string;
}

export interface NotificationContextValue {
  unreadCount: number;
  notifications: Notification[];
  markAsRead: (id: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  refresh: () => Promise<void>;
}

const NotificationContext = createContext<NotificationContextValue | null>(null);

const emptyValue: NotificationContextValue = {
  unreadCount: 0,
  notifications: [],
  markAsRead: async () => {},
  markAllAsRead: async () => {},
  refresh: async () => {},
};

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const notifyUrl = process.env.NEXT_PUBLIC_NOTIFY_URL;
  const [unreadCount, setUnreadCount] = useState(0);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const hasWarnedRef = useRef(false);
  const lastCountRef = useRef(-1); // -1 = not yet initialised, skip toast on first load
  const lastNewIdRef = useRef<string | null>(null);
  const { toast } = useToast();

  // Keep toast functions in a ref so fetchAndMaybeToast doesn't need them as deps
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const fetchAndMaybeToast = useCallback(async () => {
    if (!notifyUrl) return;
    try {
      const res = await fetch(`${notifyUrl}/api/notifications/unread`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      const count: number = data.count ?? 0;

      if (lastCountRef.current >= 0 && count > lastCountRef.current) {
        // New notifications arrived — fetch the latest one and toast
        try {
          const listRes = await fetch(`${notifyUrl}/api/notifications?limit=1`, { credentials: 'include' });
          if (listRes.ok) {
            const listData = await listRes.json();
            const latest: Notification | undefined = listData.notifications?.[0] ?? listData[0];
            if (latest && latest.id !== lastNewIdRef.current) {
              lastNewIdRef.current = latest.id;
              if (latest.urgency === 'urgent') {
                toastRef.current.warning(latest.title);
              } else {
                toastRef.current.info(latest.title);
              }
            }
          }
        } catch {}
      }

      lastCountRef.current = count;
      setUnreadCount(count);
    } catch {
      if (!hasWarnedRef.current) {
        console.warn('[notifications] notify service unavailable — bell will show 0 unread');
        hasWarnedRef.current = true;
      }
    }
  }, [notifyUrl]);

  useEffect(() => {
    if (!notifyUrl) return;
    fetchAndMaybeToast();
    const interval = setInterval(fetchAndMaybeToast, 30_000);
    return () => clearInterval(interval);
  }, [notifyUrl, fetchAndMaybeToast]);

  const refresh = useCallback(async () => {
    if (!notifyUrl) return;
    try {
      const res = await fetch(`${notifyUrl}/api/notifications?limit=20`, { credentials: 'include' });
      if (!res.ok) return;
      const data = await res.json();
      setNotifications(data.notifications ?? data ?? []);
    } catch {}
  }, [notifyUrl]);

  const markAsRead = useCallback(async (id: string) => {
    if (!notifyUrl) return;
    try {
      await fetch(`${notifyUrl}/api/notifications/${id}/read`, {
        method: 'POST',
        credentials: 'include',
      });
      setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch {}
  }, [notifyUrl]);

  const markAllAsRead = useCallback(async () => {
    if (!notifyUrl) return;
    try {
      await fetch(`${notifyUrl}/api/notifications/read-all`, {
        method: 'POST',
        credentials: 'include',
      });
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnreadCount(0);
      lastCountRef.current = 0;
    } catch {}
  }, [notifyUrl]);

  return (
    <NotificationContext.Provider value={{ unreadCount, notifications, markAsRead, markAllAsRead, refresh }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationContextValue {
  return useContext(NotificationContext) ?? emptyValue;
}
