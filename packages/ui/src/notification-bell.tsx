'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useNotifications, type Notification } from './notification-provider';

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

function BellIcon({ className }: Readonly<{ className?: string }>) {
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

/**
 * Inline action card for `broker:consent-request` notifications.
 * Renders Approve / Deny buttons directly in the bell dropdown.
 *
 * Approve: creates a consent grant via `POST /api/broker/consent`, then marks
 * the notification as read.
 * Deny: marks as read only (no grant created).
 */
function ConsentRequestCard({
  notification,
  onDone,
}: Readonly<{ notification: Notification; onDone: () => void }>) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const data = notification.data ?? {};
  const requesterDid = typeof data.requesterDid === 'string' ? data.requesterDid : '';
  const purpose = typeof data.purpose === 'string' ? data.purpose : '';
  const fields: string[] = Array.isArray(data.fields)
    ? (data.fields as unknown[]).filter((f): f is string => typeof f === 'string')
    : [];

  async function handleApprove() {
    setBusy('approve');
    try {
      await fetch('/api/broker/consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          subject: undefined, // server resolves from session
          grantedTo: requesterDid,
          purpose,
          allowedFields: fields.length > 0 ? fields : [purpose],
        }),
      });
    } catch {
      // ignore — best effort
    } finally {
      onDone();
    }
  }

  async function handleDeny() {
    setBusy('deny');
    onDone();
  }

  const shortDid = requesterDid.length > 30
    ? `${requesterDid.slice(0, 20)}\u2026${requesterDid.slice(-6)}`
    : requesterDid;

  return (
    <div
      className={`px-4 py-3 border-b border-gray-800 last:border-0 ${
        notification.read ? '' : 'bg-amber-500/5'
      }`}
    >
      <div className="flex items-start gap-2 mb-2">
        <span className="shrink-0 w-2 h-2 rounded-full mt-1.5">
          {!notification.read && (
            <span className="block w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />
          )}
        </span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white">{notification.title}</p>
          {shortDid && (
            <p className="text-xs text-gray-500 mt-0.5 truncate" title={requesterDid}>{shortDid}</p>
          )}
          {fields.length > 0 && (
            <p className="text-xs text-gray-400 mt-0.5">{fields.join(', ')}</p>
          )}
          <p className="text-xs text-gray-500 mt-1">{relativeTime(notification.createdAt)}</p>
        </div>
      </div>
      <div className="flex gap-2 pl-4">
        <button
          onClick={handleApprove}
          disabled={busy !== null}
          className="flex-1 py-1.5 text-xs font-medium bg-amber-500 hover:bg-amber-400 text-black rounded transition disabled:opacity-50"
        >
          {busy === 'approve' ? '…' : 'Approve'}
        </button>
        <button
          onClick={handleDeny}
          disabled={busy !== null}
          className="flex-1 py-1.5 text-xs font-medium bg-white/10 hover:bg-white/20 text-gray-300 hover:text-white rounded transition disabled:opacity-50"
        >
          {busy === 'deny' ? '…' : 'Deny'}
        </button>
      </div>
    </div>
  );
}

export function NotificationBell() {
  const { unreadCount, notifications, markAsRead, markAllAsRead, refresh } = useNotifications();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const handleOpen = useCallback(async () => {
    if (open) {
      setOpen(false);
    } else {
      setOpen(true);
      setLoading(true);
      await refresh();
      setLoading(false);
    }
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node | null)) {
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
  const unreadSuffix = unreadCount > 0 ? `, ${unreadCount} unread` : '';

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={handleOpen}
        className={`relative p-2 rounded-lg transition ${
          open ? 'bg-gray-100 dark:bg-gray-800' : 'hover:bg-gray-100 dark:hover:bg-gray-800'
        }`}
        title="Notifications"
        aria-label={`Notifications${unreadSuffix}`}
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
            {(() => {
              if (loading) return <div className="px-4 py-6 text-center text-sm text-gray-400">Loading…</div>;
              if (notifications.length === 0) return <div className="px-4 py-6 text-center text-sm text-gray-400">No notifications yet</div>;
              return (
              notifications.map(notification => {
                // Consent-request notifications get an inline Approve/Deny card.
                if (notification.scope === 'broker:consent-request' && !notification.read) {
                  return (
                    <ConsentRequestCard
                      key={notification.id}
                      notification={notification}
                      onDone={() => markAsRead(notification.id)}
                    />
                  );
                }
                return (
                  <button
                    key={notification.id}
                    onClick={() => markAsRead(notification.id)}
                    className={`w-full text-left px-4 py-3 border-b border-gray-800 last:border-0 hover:bg-gray-800 transition flex items-start gap-3 ${
                      notification.read ? '' : 'bg-gray-800/50'
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
                );
              })
            );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
