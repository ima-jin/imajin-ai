'use client';

import { createContext, useContext } from 'react';

interface ChatConfig {
  chatUrl: string;
  authUrl: string;
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
  children,
}: ChatConfig & { children: React.ReactNode }) {
  return (
    <ChatContext.Provider value={{ chatUrl, authUrl }}>
      {children}
    </ChatContext.Provider>
  );
}
