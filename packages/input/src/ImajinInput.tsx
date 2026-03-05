import React, { useState } from 'react';
import { EmojiPicker } from './EmojiPicker';
import { VoiceRecorder, type VoiceRecorderProps } from './VoiceRecorder';
import { LocationPicker, type LocationData } from './LocationPicker';
import { FileAttachment, type FileAttachmentData } from './FileAttachment';

export type InputFeature = 'voice' | 'emoji' | 'files' | 'location';

export interface MediaRef {
  id: string;
  type: string;
  url: string;
}

export interface ImajinInputProps {
  /** Called when text is submitted (Enter or Send button) */
  onSubmit: (text: string) => void | Promise<void>;
  /** Called when a media file is ready (voice recording, file attachment) */
  onMediaReady?: (file: File) => void | Promise<void>;
  /** Called with transcribed text from voice recording */
  onTranscribed?: (text: string) => void;
  /** Called when location is attached */
  onLocation?: (location: LocationData) => void;
  /** Which input features to enable */
  features?: InputFeature[];
  /** Input service URL for voice transcription */
  inputServiceUrl?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}

export function ImajinInput({
  onSubmit,
  onMediaReady,
  onTranscribed,
  onLocation,
  features = [],
  inputServiceUrl,
  placeholder = 'Type a message...',
  disabled = false,
  className = '',
}: ImajinInputProps) {
  const [value, setValue] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [attachment, setAttachment] = useState<FileAttachmentData | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed && !attachment) return;
    if (trimmed) onSubmit(trimmed);
    setValue('');
  }

  function handleEmojiSelect(emoji: string) {
    setValue((prev) => prev + emoji);
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  }

  function handleVoiceRecorded(blob: Blob) {
    if (onMediaReady) {
      const file = new File([blob], `recording-${Date.now()}.webm`, {
        type: blob.type || 'audio/webm',
      });
      onMediaReady(file);
    }
  }

  function handleTranscribed(text: string) {
    if (onTranscribed) {
      onTranscribed(text);
    } else {
      // Default: put transcribed text in the input
      setValue((prev) => (prev ? `${prev} ${text}` : text));
    }
  }

  function handleFileAttach(data: FileAttachmentData) {
    setAttachment(data);
    if (onMediaReady) onMediaReady(data.file);
  }

  const hasEmoji = features.includes('emoji');
  const hasVoice = features.includes('voice');
  const hasFiles = features.includes('files');
  const hasLocation = features.includes('location');

  return (
    <div className={`w-full ${className}`}>
      {/* File attachment preview */}
      {attachment && (
        <div className="mb-2">
          <FileAttachment
            onAttach={handleFileAttach}
            onRemove={() => setAttachment(null)}
            disabled={disabled}
          />
        </div>
      )}

      {/* Location display is handled by LocationPicker internally */}

      <form onSubmit={handleSubmit} className="flex items-center gap-2 w-full relative">
        {/* Emoji button + picker */}
        {hasEmoji && (
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowEmoji(!showEmoji)}
              className="p-2 text-gray-500 hover:text-orange-400 transition-colors"
              title="Emoji"
            >
              😊
            </button>
            {showEmoji && (
              <EmojiPicker
                onSelect={handleEmojiSelect}
                onClose={() => setShowEmoji(false)}
              />
            )}
          </div>
        )}

        {/* Text input */}
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          className="flex-1 bg-[#1a1a1a] border border-gray-700 rounded-lg px-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-orange-500 transition-colors"
        />

        {/* File attachment */}
        {hasFiles && !attachment && (
          <FileAttachment
            onAttach={handleFileAttach}
            disabled={disabled}
          />
        )}

        {/* Location */}
        {hasLocation && (
          <LocationPicker
            onLocation={onLocation || (() => {})}
            disabled={disabled}
          />
        )}

        {/* Voice recorder */}
        {hasVoice && (
          <VoiceRecorder
            onRecorded={handleVoiceRecorded}
            inputServiceUrl={inputServiceUrl}
            onTranscribed={handleTranscribed}
            disabled={disabled}
          />
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={disabled || (!value.trim() && !attachment)}
          className="px-4 py-2 bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Send
        </button>
      </form>
    </div>
  );
}
