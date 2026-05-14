'use client';

import { Chat, ChatProvider } from '@imajin/chat';

const CHAT_URL = process.env.NEXT_PUBLIC_CHAT_URL || 'http://localhost:3007';
const AUTH_URL = '';  // same-origin proxy
const MEDIA_URL = process.env.NEXT_PUBLIC_MEDIA_URL || 'http://localhost:3009';

interface CommunityChatProps {
  communityDid: string;
}

export function CommunityChat({ communityDid }: CommunityChatProps) {
  return (
    <ChatProvider chatUrl={CHAT_URL} authUrl={AUTH_URL} mediaUrl={MEDIA_URL}>
      <div className="h-[500px]">
        <Chat
          did={communityDid}
          enableVoice
          enableMedia
          enableLocation
          mediaUrl={MEDIA_URL}
        />
      </div>
    </ChatProvider>
  );
}
