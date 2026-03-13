'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { useChatConfig } from '../ChatProvider';

interface WSMessage {
  type: string;
  [key: string]: unknown;
}

interface TypingUser {
  did: string;
  name?: string;
  timeout: ReturnType<typeof setTimeout>;
}

interface UseChatWebSocketResult {
  isConnected: boolean;
  lastMessage: WSMessage | null;
  typingUsers: Map<string, TypingUser>;
  sendTyping: () => void;
  stopTyping: () => void;
}

function chatUrlToWsUrl(chatUrl: string): string {
  return chatUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
}

export function useChatWebSocket(did: string): UseChatWebSocketResult {
  const { chatUrl } = useChatConfig();
  const wsUrl = `${chatUrlToWsUrl(chatUrl)}/ws`;

  const wsRef = useRef<WebSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WSMessage | null>(null);
  const [typingUsers, setTypingUsers] = useState<Map<string, TypingUser>>(new Map());
  const reconnectDelay = useRef(1000);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const mountedRef = useRef(true);
  const didRef = useRef(did);
  didRef.current = did;

  const cleanup = useCallback(() => {
    if (pingTimer.current) clearInterval(pingTimer.current);
    if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    pingTimer.current = null;
    reconnectTimer.current = null;
  }, []);

  const connect = useCallback(() => {
    if (!mountedRef.current) return;
    cleanup();

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) { ws.close(); return; }
      reconnectDelay.current = 1000;
      // Don't set connected yet — wait for 'connected' or handle 'auth_required'
    };

    ws.onmessage = (event) => {
      try {
        const data: WSMessage = JSON.parse(event.data as string);
        if (data.type === 'pong') return;

        // Handle deferred auth — fetch a WS token via same-origin API
        if (data.type === 'auth_required') {
          fetch(`${chatUrl}/api/ws-token`, { credentials: 'include' })
            .then(res => res.ok ? res.json() : null)
            .then(tokenData => {
              if (tokenData?.token && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'auth', token: tokenData.token }));
              }
            })
            .catch(() => {});
          return;
        }

        // Server confirmed auth — now subscribe and set connected
        if (data.type === 'connected') {
          setIsConnected(true);
          ws.send(JSON.stringify({ type: 'subscribe', did: didRef.current }));
          if (!pingTimer.current) {
            pingTimer.current = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
              }
            }, 30000);
          }
          return;
        }

        if (data.type === 'user_typing') {
          const senderDid = data.did as string;
          if (!senderDid || senderDid === didRef.current) return;
          setTypingUsers(prev => {
            const next = new Map(prev);
            const existing = next.get(senderDid);
            if (existing) clearTimeout(existing.timeout);
            const timeout = setTimeout(() => {
              setTypingUsers(m => {
                const n = new Map(m);
                n.delete(senderDid);
                return n;
              });
            }, 5000);
            next.set(senderDid, { did: senderDid, name: data.name as string | undefined, timeout });
            return next;
          });
          return;
        }

        if (data.type === 'user_stop_typing') {
          const senderDid = data.did as string;
          if (!senderDid) return;
          setTypingUsers(prev => {
            const existing = prev.get(senderDid);
            if (existing) clearTimeout(existing.timeout);
            const next = new Map(prev);
            next.delete(senderDid);
            return next;
          });
          return;
        }

        setLastMessage(data);
      } catch {}
    };

    ws.onclose = () => {
      setIsConnected(false);
      cleanup();
      if (mountedRef.current) {
        reconnectTimer.current = setTimeout(() => {
          reconnectDelay.current = Math.min(reconnectDelay.current * 2, 30000);
          connect();
        }, reconnectDelay.current);
      }
    };

    ws.onerror = () => {
      ws.close();
    };
  }, [wsUrl, cleanup]);

  useEffect(() => {
    mountedRef.current = true;
    connect();
    return () => {
      mountedRef.current = false;
      cleanup();
      wsRef.current?.close();
    };
  }, [connect, cleanup]);

  // Re-subscribe when did changes while connected
  useEffect(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'subscribe', did }));
    }
    setTypingUsers(new Map());
  }, [did]);

  const sendTyping = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'typing', did: didRef.current }));
    }
  }, []);

  const stopTyping = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'stop_typing', did: didRef.current }));
    }
  }, []);

  return { isConnected, lastMessage, typingUsers, sendTyping, stopTyping };
}
