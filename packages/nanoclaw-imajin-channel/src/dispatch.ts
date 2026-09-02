/**
 * Pure mapping from an inbound Imajin `chat_message` WS frame to the shape
 * NanoClaw's `ChannelAdapter.setup().onInbound(...)` expects. Split out from
 * the WS transport so it is testable without a live socket.
 */
import type { ChatMessageFrame } from './imajin-client.js';
import type { NanoClawInboundMessage } from './nanoclaw-types.js';

export interface DispatchTarget {
  /** NanoClaw's `platformId` — the conversation DID doubles as the platform-level address. */
  platformId: string;
  /** This channel never models conversations as threads (supportsThreads: false). */
  threadId: null;
  message: NanoClawInboundMessage;
}

/**
 * Convert a validated `chat_message` frame into NanoClaw's inbound-dispatch
 * shape. Every DM is, by construction, addressed to the bot — `isMention` is
 * always `true`, mirroring how DM-shaped Chat SDK bridges set it
 * (`chat-sdk-bridge.ts`'s `onDirectMessage` handler, imajin-ai#1932 step 0
 * research), and `isGroup` is always `false` since this channel only ever
 * carries DM-keyed conversations.
 */
export function toDispatchTarget(frame: ChatMessageFrame): DispatchTarget {
  return {
    platformId: frame.conversationDid,
    threadId: null,
    message: {
      id: frame.message.id,
      kind: 'chat',
      content: frame.message.content,
      timestamp: frame.message.createdAt,
      isMention: true,
      isGroup: false,
    },
  };
}
