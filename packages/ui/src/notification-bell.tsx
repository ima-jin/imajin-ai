'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNotifications } from './notification-provider';

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

function BellIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  );
}

export function NotificationBell() {
  const { unreadCount, notifications, markAsRead, markAllAsRead, refresh } = useNotifications();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleOpen = useCallback(async () => {
    if (!open) {
      setOpen(true);
      setLoading(true);
      await refresh();
      setLoading(false);
    } else {
      setOpen(false);
    }
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const hasUnread = notifications.some(n => !n.read);

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={handleOpen}
        className={`relative p-2 rounded-lg transition ${
          open ? 'bg-gray-100 dark:bg-gray-800' : 'hover:bg-gray-100 dark:hover:bg-gray-800'
        }`}
        title="Notifications"
        aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ''}`}
        aria-expanded={open}
      >
        <BellIcon className="w-5 h-5 text-gray-600 dark:text-gray-300" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] font-bold rounded-full min-w-[1.1rem] h-[1.1rem] flex items-center justify-center px-1 leading-none pointer-events-none">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-gray-900 border border-gray-700 rounded-lg shadow-lg z-50 flex flex-col max-h-[24rem]">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-700 shrink-0">
            <span className="text-sm font-semibold text-white">Notifications</span>
            {hasUnread && (
              <button
                onClick={() => markAllAsRead()}
                className="text-xs text-blue-400 hover:text-blue-300 transition"
              >
                Mark all as read
              </button>
            )}
          </div>

          {/* Body */}
          <div className="overflow-y-auto flex-1">
            {loading ? (
              <div className="px-4 py-6 text-center text-sm text-gray-400">Loading…</div>
            ) : notifications.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-gray-400">No notifications yet</div>
            ) : (
              notifications.map(notification => (
                <button
                  key={notification.id}
                  onClick={() => markAsRead(notification.id)}
                  className={`w-full text-left px-4 py-3 border-b border-gray-800 last:border-0 hover:bg-gray-800 transition flex items-start gap-3 ${
                    !notification.read ? 'bg-gray-800/50' : ''
                  }`}
                >
                  {/* Unread dot — space always reserved so text aligns */}
                  <span className="shrink-0 w-2 h-2 rounded-full mt-1.5 flex items-center justify-center">
                    {!notification.read && (
                      <span className="block w-2 h-2 rounded-full bg-blue-500" aria-hidden="true" />
                    )}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-white truncate">{notification.title}</p>
                    {notification.body && (
                      <p className="text-xs text-gray-400 mt-0.5 line-clamp-2">{notification.body}</p>
                    )}
                    <p className="text-xs text-gray-500 mt-1">{relativeTime(notification.createdAt)}</p>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
