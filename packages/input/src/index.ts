'use client';

// Every export in this file is a component or hook that runs in the
// browser. Declared here (rather than relying on it surviving from the
// individual source files) so tsup's single-bundle output still carries the
// directive as the first statement of dist/index.js — esbuild does not
// hoist per-file 'use client' directives across module boundaries when
// bundling (see packages/ui/src/index.ts for the established pattern).

// Core component
export { ImajinInput } from './ImajinInput';
export type { ImajinInputProps, InputFeature, TranscriptionMeta } from './ImajinInput';

// Sub-components (can be used independently)
export { EmojiPicker } from './EmojiPicker';
export { VoiceRecorder } from './VoiceRecorder';
export { LocationPicker } from './LocationPicker';
export type { LocationData, LocationPickerProps } from './LocationPicker';
export { FileAttachment } from './FileAttachment';
export type { FileAttachmentData, FileAttachmentProps } from './FileAttachment';
