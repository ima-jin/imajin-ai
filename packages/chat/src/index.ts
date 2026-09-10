'use client';

// Every export in this file is a component or hook that runs in the
// browser. Declared here (rather than relying on it surviving from the
// individual source files) so tsup's single-bundle output still carries the
// directive as the first statement of dist/index.js — esbuild does not
// hoist per-file 'use client' directives across module boundaries when
// bundling (see packages/ui/src/index.ts for the established pattern).
export { MessageBubble } from './MessageBubble';
export type { MessageBubbleProps } from './MessageBubble';
export { VoiceMessage } from './VoiceMessage';
export { MediaMessage } from './MediaMessage';
export { LocationMessage } from './LocationMessage';
export { ReactionPicker } from './ReactionPicker';
export { LinkPreviewCard } from './LinkPreviewCard';
export type { MessageContent, TextContent, VoiceContent, MediaContent, LocationContent, MessageMeta } from './message-types';

export { Chat } from './Chat';
export { ChatProvider, useChatConfig } from './ChatProvider';
export { useChatMessages } from './hooks/useChatMessages';
export type { ChatMessage } from './hooks/useChatMessages';
export { useChatActions } from './hooks/useChatActions';
export { useChatWebSocket } from './hooks/useChatWebSocket';
export { useChatAccess } from './hooks/useChatAccess';
export { useDidNames } from './hooks/useDidNames';

/** @deprecated Use @imajin/input instead */
export { VoiceRecorder } from '@imajin/input';
export { NameDisplaySelector } from './NameDisplaySelector';
export type { NameDisplayPolicy, DisplayPref } from './NameDisplaySelector';

export { useFileUpload } from './hooks/useFileUpload';
export { useVoiceRecording } from './hooks/useVoiceRecording';
export { useLocationShare } from './hooks/useLocationShare';
export { useMentions, EVERYONE_DID } from './hooks/useMentions';
export type { Mention, MentionResult, Member } from './hooks/useMentions';
export { MentionPicker } from './MentionPicker';
