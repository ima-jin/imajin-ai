'use client';

import { useState, useCallback } from 'react';
import { useChatConfig } from '../ChatProvider';

interface SendOptions {
  replyTo?: string;
}

interface UseChatActionsResult {
  sendMessage: (content: { type: string; text?: string; [key: string]: unknown }, options?: SendOptions) => Promise<void>;
  addReaction: (messageId: string, emoji: string) => Promise<void>;
  removeReaction: (messageId: string, emoji: string) => Promise<void>;
  editMessage: (messageId: string, content: object) => Promise<void>;
  deleteMessage: (messageId: string) => Promise<void>;
  markRead: () => Promise<void>;
  isSending: boolean;
}

export function useChatActions(did: string): UseChatActionsResult {
  const { chatUrl } = useChatConfig();
  const [isSending, setIsSending] = useState(false);

  const request = useCallback(
    async (method: string, path: string, body?: object) => {
      const res = await fetch(`${chatUrl}${path}`, {
        method,
        credentials: 'include',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error(`${method} ${path} failed: ${res.status}`);
      return res;
    },
    [chatUrl]
  );

  const sendMessage = useCallback(
    async (content: { type: string; text?: string; [key: string]: unknown }, options?: SendOptions) => {
      setIsSending(true);
      try {
        await request('POST', `/api/d/${did}/messages`, {
          content,
          ...(options?.replyTo && { replyToMessageId: options.replyTo }),
        });
      } finally {
        setIsSending(false);
      }
    },
    [did, request]
  );

  const addReaction = useCallback(
    (messageId: string, emoji: string) =>
      request('POST', `/api/d/${did}/messages/${messageId}/reactions`, { emoji }).then(() => undefined),
    [did, request]
  );

  const removeReaction = useCallback(
    (messageId: string, emoji: string) =>
      request('DELETE', `/api/d/${did}/messages/${messageId}/reactions`, { emoji }).then(() => undefined),
    [did, request]
  );

  const editMessage = useCallback(
    (messageId: string, content: object) =>
      request('PATCH', `/api/d/${did}/messages/${messageId}`, { content }).then(() => undefined),
    [did, request]
  );

  const deleteMessage = useCallback(
    (messageId: string) =>
      request('DELETE', `/api/d/${did}/messages/${messageId}`).then(() => undefined),
    [did, request]
  );

  const markRead = useCallback(
    () => request('POST', `/api/d/${did}/read`).then(() => undefined),
    [did, request]
  );

  return { sendMessage, addReaction, removeReaction, editMessage, deleteMessage, markRead, isSending };
}
