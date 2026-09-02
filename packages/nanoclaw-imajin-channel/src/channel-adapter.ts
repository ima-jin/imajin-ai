/**
 * The Imajin chat `ChannelAdapter` (imajin-ai#1932): makes a NanoClaw
 * instance reachable by DM at its own agent DID through the *existing*
 * jin.imajin.ai chat surface — no new UI.
 *
 * This module is meant to be copied into a NanoClaw checkout's
 * `src/channels/imajin-chat.ts` and self-registered with one barrel-import
 * line (see `packages/claw-envelope`'s rendered `APPLY.md`) — the same
 * install shape every real `/add-<channel>` skill uses. See
 * `src/nanoclaw-types.ts` for why the `ChannelAdapter` contract is declared
 * locally rather than imported.
 */
import { isChatMessageFrame, parseFrame, sendChatMessage } from './imajin-client.js';
import { toDispatchTarget } from './dispatch.js';
import { ImajinChatConnection } from './ws-connection.js';
import type {
  NanoClawChannelAdapter,
  NanoClawChannelDefaults,
  NanoClawChannelSetup,
  NanoClawOutboundMessage,
} from './nanoclaw-types.js';

export interface ImajinChatAdapterConfig {
  kernelBaseUrl: string;
  agentDid: string;
  privateKeyHex: string;
}

/**
 * DM-only defaults (imajin-ai#1932's first job is a DM round trip): every
 * inbound message engages (`engagePattern: '.'`), threads are not modeled
 * (this channel is DM-shaped, one conversation per DID pair), and unknown
 * senders are politely declined rather than gated behind an approval card —
 * the same `decline_notify` shape `fallbackChannelDefaults` documents for
 * DM-shaped channels.
 */
const CHANNEL_DEFAULTS: NanoClawChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'decline_notify' },
  group: { engageMode: 'mention-sticky', threads: false, unknownSenderPolicy: 'decline_notify' },
  mentions: 'dm-only',
};

export function createImajinChatAdapter(config: ImajinChatAdapterConfig): NanoClawChannelAdapter {
  let hostConfig: NanoClawChannelSetup;
  let connection: ImajinChatConnection | null = null;

  return {
    name: 'imajin-chat',
    channelType: 'imajin-chat',
    supportsThreads: false,
    defaults: CHANNEL_DEFAULTS,

    async setup(setup: NanoClawChannelSetup): Promise<void> {
      hostConfig = setup;
      connection = new ImajinChatConnection(
        { kernelBaseUrl: config.kernelBaseUrl, did: config.agentDid, privateKeyHex: config.privateKeyHex },
        (raw) => {
          const frame = parseFrame(raw);
          if (!frame || !isChatMessageFrame(frame)) return;
          // Never let a bad inbound message crash the socket handler — log
          // and drop, matching the reference bridge's dispatch discipline.
          const target = toDispatchTarget(frame);
          void Promise.resolve(hostConfig.onInbound(target.platformId, target.threadId, target.message)).catch(
            (err: unknown) => {
              console.error('[imajin-chat] onInbound handler failed', err);
            },
          );
        },
      );
      await connection.start();
    },

    async teardown(): Promise<void> {
      connection?.stop();
      connection = null;
    },

    isConnected(): boolean {
      return connection?.isConnected() ?? false;
    },

    /**
     * Reply as the agent's own DID — no `X-Acting-For`, structurally
     * `onBehalfOf: "self"` (imajin-ai#1545). `platformId` is the conversation
     * DID (see `dispatch.ts`).
     */
    async deliver(platformId: string, _threadId: string | null, message: NanoClawOutboundMessage): Promise<string | undefined> {
      const content = message.content as Record<string, unknown>;
      const text = (content.markdown as string) || (content.text as string) || '';
      if (!text) return undefined;
      const sent = await sendChatMessage(
        { kernelBaseUrl: config.kernelBaseUrl, did: config.agentDid, privateKeyHex: config.privateKeyHex },
        platformId,
        text,
      );
      return sent.id;
    },
  };
}
