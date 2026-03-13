'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useChatConfig } from '../ChatProvider';

export interface ChatMessage {
  id: string;
  did: string;
  senderDid: string;
  content: { type: string; text?: string; [key: string]: unknown };
  replyTo?: string;
  reactions?: { emoji: string; senderDid: string }[];
  createdAt: string;
  editedAt?: string;
}

interface UseChatMessagesResult {
  messages: ChatMessage[];
  hasMore: boolean;
  loadMore: () => void;
  isLoading: boolean;
  error: Error | null;
  pushMessage: (message: ChatMessage) => void;
  updateMessage: (id: string, updates: Partial<ChatMessage>) => void;
  removeMessage: (id: string) => void;
  addReactionToMessage: (messageId: string, emoji: string, senderDid: string) => void;
  removeReactionFromMessage: (messageId: string, emoji: string, senderDid: string) => void;
}

export function useChatMessages(did: string): UseChatMessagesResult {
  const { chatUrl } = useChatConfig();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const cursorRef = useRef<string | undefined>(undefined);
  const initialLoadDone = useRef(false);

  const fetchMessages = useCallback(async (before?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (before) params.set('before', before);
      const res = await fetch(
        `${chatUrl}/api/d/${did}/messages?${params}`,
        { credentials: 'include' }
      );
      if (!res.ok) throw new Error(`Failed to fetch messages: ${res.status}`);
      const data = await res.json();
      const raw: Record<string, unknown>[] = data.messages ?? data;
      // Map API field names to ChatMessage interface (API returns fromDid, we use senderDid)
      const fetched: ChatMessage[] = raw.map((msg: any) => {
        const mapped: ChatMessage = {
          ...msg,
          senderDid: msg.senderDid ?? msg.fromDid,
          did: msg.did ?? msg.conversationDid,
          reactions: msg.reactions?.map((r: any) => ({
            ...r,
            senderDid: r.senderDid ?? r.fromDid,
          })),
        };
        // Normalize legacy media messages (stored with content_type "text" + mediaType/mediaPath fields)
        if (
          mapped.content.type === 'text' &&
          !mapped.content.text?.trim() &&
          msg.mediaType &&
          msg.mediaPath
        ) {
          const meta = msg.mediaMeta || {};
          mapped.content = {
            type: 'media',
            assetId: `__legacy_chat__/${msg.mediaPath}`,
            filename: meta.originalName || msg.mediaPath.split('/').pop() || 'image',
            mimeType: meta.mimeType || (msg.mediaType === 'image' ? 'image/jpeg' : 'application/octet-stream'),
            size: meta.size || 0,
            width: meta.width,
            height: meta.height,
          };
        }
        return mapped;
      });
      // Oldest first
      const sorted = [...fetched].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
      if (before) {
        setMessages(prev => [...sorted, ...prev]);
      } else {
        setMessages(sorted);
      }
      setHasMore(data.hasMore ?? fetched.length === 50);
      if (sorted.length > 0) {
        cursorRef.current = sorted[0].id;
      }
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [chatUrl, did]);

  useEffect(() => {
    if (!initialLoadDone.current) {
      initialLoadDone.current = true;
      cursorRef.current = undefined;
      setMessages([]);
      fetchMessages();
    }
  }, [fetchMessages]);

  // Reset when did changes
  useEffect(() => {
    initialLoadDone.current = false;
    cursorRef.current = undefined;
    setMessages([]);
    setHasMore(false);
    setError(null);
    fetchMessages();
  }, [did]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = useCallback(() => {
    if (!isLoading && hasMore) {
      fetchMessages(cursorRef.current);
    }
  }, [isLoading, hasMore, fetchMessages]);

  const pushMessage = useCallback((message: ChatMessage) => {
    // Normalize field names (WebSocket messages use API naming)
    const raw = message as any;
    const normalized: ChatMessage = {
      ...message,
      senderDid: message.senderDid ?? raw.fromDid,
      did: message.did ?? raw.conversationDid,
    };
    // Normalize legacy media messages coming via WebSocket
    if (
      normalized.content.type === 'text' &&
      !normalized.content.text?.trim() &&
      raw.mediaType &&
      raw.mediaPath
    ) {
      const meta = raw.mediaMeta || {};
      normalized.content = {
        type: 'media',
        assetId: `__legacy_chat__/${raw.mediaPath}`,
        filename: meta.originalName || raw.mediaPath.split('/').pop() || 'image',
        mimeType: meta.mimeType || (raw.mediaType === 'image' ? 'image/jpeg' : 'application/octet-stream'),
        size: meta.size || 0,
        width: meta.width,
        height: meta.height,
      };
    }
    setMessages(prev => {
      if (prev.some(m => m.id === normalized.id)) return prev;
      return [...prev, normalized];
    });
  }, []);

  const updateMessage = useCallback((id: string, updates: Partial<ChatMessage>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...updates } : m));
  }, []);

  const removeMessage = useCallback((id: string) => {
    setMessages(prev => prev.filter(m => m.id !== id));
  }, []);

  const addReactionToMessage = useCallback((messageId: string, emoji: string, senderDid: string) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== messageId) return m;
      const reactions = m.reactions ? [...m.reactions] : [];
      if (reactions.some(r => r.emoji === emoji && r.senderDid === senderDid)) return m;
      return { ...m, reactions: [...reactions, { emoji, senderDid }] };
    }));
  }, []);

  const removeReactionFromMessage = useCallback((messageId: string, emoji: string, senderDid: string) => {
    setMessages(prev => prev.map(m => {
      if (m.id !== messageId) return m;
      const reactions = (m.reactions || []).filter(r => !(r.emoji === emoji && r.senderDid === senderDid));
      return { ...m, reactions };
    }));
  }, []);

  return { messages, hasMore, loadMore, isLoading, error, pushMessage, updateMessage, removeMessage, addReactionToMessage, removeReactionFromMessage };
}
