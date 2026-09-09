'use client';

import { createContext, useContext, useMemo } from 'react';

interface ChatConfig {
  chatUrl: string;
  authUrl: string;
  inputUrl?: string;
  mediaUrl?: string;
  connectionsUrl?: string;
}

const ChatContext = createContext<ChatConfig | null>(null);

export function useChatConfig(): ChatConfig {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChatConfig must be used within a ChatProvider');
  return ctx;
}

export function ChatProvider({
  chatUrl,
  authUrl,
  inputUrl,
  mediaUrl,
  connectionsUrl,
  children,
}: Readonly<ChatConfig & { children: React.ReactNode }>) {
  const value = useMemo(
    () => ({ chatUrl, authUrl, inputUrl, mediaUrl, connectionsUrl }),
    [chatUrl, authUrl, inputUrl, mediaUrl, connectionsUrl],
  );
  return (
    <ChatContext.Provider value={value}>
      {children}
    </ChatContext.Provider>
  );
}
