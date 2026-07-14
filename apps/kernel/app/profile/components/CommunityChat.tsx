'use client';

import { Chat, ChatProvider } from '@imajin/chat';
import { buildPublicUrl } from '@imajin/config';

const CHAT_URL = buildPublicUrl('chat');
const AUTH_URL = '';  // same-origin proxy
const MEDIA_URL = buildPublicUrl('media');

interface CommunityChatProps {
  communityDid: string;
}

export function CommunityChat({ communityDid }: Readonly<CommunityChatProps>) {
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
