/**
 * Local mirror of the subset of NanoClaw's `ChannelAdapter` contract this
 * package implements against (verified against `src/channels/adapter.ts` in
 * a clone of `qwibitai/nanoclaw`, 2026-09-02 push).
 *
 * NanoClaw is not published as an npm package, so there is no dependency to
 * import these from — this module declares the shape a NanoClaw checkout
 * expects at `src/channels/imajin-chat.ts` (see this package's README and
 * `packages/claw-envelope`'s rendered `APPLY.md`). Field names and semantics
 * are kept identical to upstream on purpose so a drift check is a diff, not
 * a rewrite. This is NOT a fork of NanoClaw — nothing here is copied from or
 * committed back to `qwibitai/nanoclaw`; it is a client-side contract
 * declaration, the same way any package declares the shape of an external
 * API it calls.
 */

/** Mirrors NanoClaw's `InboundMessage` (`src/channels/adapter.ts`). */
export interface NanoClawInboundMessage {
  id: string;
  kind: 'chat' | 'chat-sdk';
  content: unknown;
  timestamp: string;
  isMention?: boolean;
  isGroup?: boolean;
}

/** Mirrors NanoClaw's `OutboundFile`. */
export interface NanoClawOutboundFile {
  filename: string;
  data: Buffer;
}

/** Mirrors NanoClaw's `OutboundMessage`. */
export interface NanoClawOutboundMessage {
  kind: string;
  content: unknown;
  files?: NanoClawOutboundFile[];
}

/** Mirrors NanoClaw's `ChannelSetup` (the callbacks the host passes to `ChannelAdapter.setup`). */
export interface NanoClawChannelSetup {
  onInbound(platformId: string, threadId: string | null, message: NanoClawInboundMessage): void | Promise<void>;
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;
  onAction(questionId: string, selectedOption: string, userId: string): void;
}

/** Mirrors NanoClaw's `ChannelDefaults` / `ChannelContextDefaults` (only the fields this adapter sets). */
export interface NanoClawChannelDefaults {
  dm: {
    engageMode: 'pattern' | 'mention' | 'mention-sticky';
    engagePattern?: string;
    threads: boolean;
    unknownSenderPolicy: 'strict' | 'request_approval' | 'decline_notify' | 'public';
  };
  group: {
    engageMode: 'pattern' | 'mention' | 'mention-sticky';
    engagePattern?: string;
    threads: boolean;
    unknownSenderPolicy: 'strict' | 'request_approval' | 'decline_notify' | 'public';
  };
  mentions: 'platform' | 'dm-only' | 'never';
}

/** Mirrors NanoClaw's `ChannelAdapter` contract, restricted to what this package implements. */
export interface NanoClawChannelAdapter {
  name: string;
  channelType: string;
  supportsThreads: boolean;
  defaults?: NanoClawChannelDefaults;
  setup(config: NanoClawChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;
  deliver(platformId: string, threadId: string | null, message: NanoClawOutboundMessage): Promise<string | undefined>;
}

/** Mirrors NanoClaw's `ChannelRegistration` (the argument to `registerChannelAdapter`). */
export interface NanoClawChannelRegistration {
  factory: () => NanoClawChannelAdapter | Promise<NanoClawChannelAdapter> | null;
  defaults?: NanoClawChannelDefaults;
  containerConfig?: {
    mounts?: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
    env?: Record<string, string>;
  };
}
