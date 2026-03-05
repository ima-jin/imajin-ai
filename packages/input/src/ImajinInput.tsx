import React, { useState, useRef, useEffect, useCallback } from 'react';
import { EmojiPicker } from './EmojiPicker';
import { VoiceRecorder } from './VoiceRecorder';
import { LocationPicker, type LocationData } from './LocationPicker';
import { FileAttachment, type FileAttachmentData } from './FileAttachment';

export type InputFeature = 'voice' | 'emoji' | 'files' | 'location';

export interface TranscriptionMeta {
  text: string;
  language: string;
  languageProbability: number;
  durationSeconds: number;
  processingTimeMs: number;
  model: string;
  segmentCount: number;
  source: 'mic' | 'upload';
}

export interface ImajinInputProps {
  onSubmit: (text: string) => void | Promise<void>;
  onMediaReady?: (file: File) => void | Promise<void>;
  onTranscribed?: (text: string) => void;
  /** Called with full transcription metadata (telemetry) */
  onTranscriptionMeta?: (meta: TranscriptionMeta) => void;
  onLocation?: (location: LocationData) => void;
  features?: InputFeature[];
  inputServiceUrl?: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Max rows before scrolling (default: 4) */
  maxRows?: number;
}

export function ImajinInput({
  onSubmit,
  onMediaReady,
  onTranscribed,
  onTranscriptionMeta,
  onLocation,
  features = [],
  inputServiceUrl,
  placeholder = 'Type a message...',
  disabled = false,
  className = '',
  maxRows = 4,
}: ImajinInputProps) {
  const [value, setValue] = useState('');
  const [showEmoji, setShowEmoji] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [attachment, setAttachment] = useState<FileAttachmentData | null>(null);
  const [transcribing, setTranscribing] = useState(false);
  const [transcribeProgress, setTranscribeProgress] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachMenuRef = useRef<HTMLDivElement>(null);

  const hasEmoji = features.includes('emoji');
  const hasVoice = features.includes('voice');
  const hasFiles = features.includes('files');
  const hasLocation = features.includes('location');
  const hasValue = value.trim().length > 0 || !!attachment;

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = 24; // ~text-sm line height
    const maxHeight = lineHeight * maxRows;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, [value, maxRows]);

  // Close attach menu on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (attachMenuRef.current && !attachMenuRef.current.contains(e.target as Node)) {
        setShowAttachMenu(false);
      }
    }
    if (showAttachMenu) {
      document.addEventListener('mousedown', handleClick);
      return () => document.removeEventListener('mousedown', handleClick);
    }
  }, [showAttachMenu]);

  function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    const trimmed = value.trim();
    if (!trimmed && !attachment) return;
    if (trimmed) onSubmit(trimmed);
    setValue('');
    setAttachment(null);
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function handleEmojiSelect(emoji: string) {
    setValue((prev) => prev + emoji);
    textareaRef.current?.focus();
  }

  // Process transcription response with telemetry
  function processTranscriptionResponse(data: any, source: 'mic' | 'upload') {
    const text = data.text || '';
    if (text) {
      setValue((prev) => (prev ? `${prev} ${text}` : text));
      if (onTranscribed) onTranscribed(text);
    }
    if (onTranscriptionMeta) {
      onTranscriptionMeta({
        text,
        language: data.language || 'unknown',
        languageProbability: data.language_probability || 0,
        durationSeconds: data.duration_seconds || 0,
        processingTimeMs: data.processing_time_ms || 0,
        model: data.model || 'unknown',
        segmentCount: data.segments?.length || 0,
        source,
      });
    }
    setTranscribing(false);
    setTranscribeProgress('');
    textareaRef.current?.focus();
  }

  // Voice recording → transcribed text goes into the input box
  function handleTranscribed(text: string) {
    // This is called by VoiceRecorder which only returns text
    // For full meta, VoiceRecorder would need updating — for now just handle text
    if (onTranscribed) {
      onTranscribed(text);
    }
    setValue((prev) => (prev ? `${prev} ${text}` : text));
    setTranscribing(false);
    setTranscribeProgress('');
    textareaRef.current?.focus();
  }

  function handleVoiceRecorded(blob: Blob) {
    setTranscribing(true);
    setTranscribeProgress('Transcribing recording...');
    if (onMediaReady) {
      const file = new File([blob], `recording-${Date.now()}.webm`, {
        type: blob.type || 'audio/webm',
      });
      onMediaReady(file);
    }
  }

  function handleFileAttach(data: FileAttachmentData) {
    setAttachment(data);
    setShowAttachMenu(false);
    if (onMediaReady) onMediaReady(data.file);
  }

  function handleLocation(loc: LocationData) {
    setShowAttachMenu(false);
    if (onLocation) onLocation(loc);
  }

  // Voice memo upload (for transcription of existing audio files)
  const voiceMemoRef = useRef<HTMLInputElement>(null);
  function handleVoiceMemoSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setShowAttachMenu(false);
    setTranscribing(true);

    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    setTranscribeProgress(`Transcribing ${file.name} (${sizeMB} MB)...`);

    const formData = new FormData();
    formData.append('file', file, file.name);
    const transcribeUrl = inputServiceUrl
      ? `${inputServiceUrl.replace(/\/+$/, '')}/api/transcribe`
      : '/api/transcribe';

    const startTime = Date.now();

    fetch(transcribeUrl, { method: 'POST', body: formData, credentials: 'include' })
      .then((res) => (res.ok ? res.json() : Promise.reject('Transcription failed')))
      .then((data) => {
        // Add client-side round trip time if server didn't include it
        if (!data.processing_time_ms) {
          data.processing_time_ms = Date.now() - startTime;
        }
        processTranscriptionResponse(data, 'upload');
      })
      .catch(() => {
        setTranscribing(false);
        setTranscribeProgress('');
        // Fallback: attach as media
        if (onMediaReady) onMediaReady(file);
      });

    if (voiceMemoRef.current) voiceMemoRef.current.value = '';
  }

  return (
    <div className={`w-full ${className}`}>
      {/* Attachment preview — above the input bar */}
      {attachment && (
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-800/60 border border-gray-700 border-b-0 rounded-t-2xl">
          {attachment.preview ? (
            <img src={attachment.preview} alt="" className="w-10 h-10 rounded-lg object-cover" />
          ) : (
            <span className="text-lg">
              {attachment.type === 'audio' ? '🎵' : attachment.type === 'video' ? '🎬' : '📄'}
            </span>
          )}
          <div className="flex-1 min-w-0">
            <p className="text-sm text-gray-300 truncate">{attachment.file.name}</p>
            <p className="text-xs text-gray-500">
              {attachment.file.size < 1024 * 1024
                ? `${(attachment.file.size / 1024).toFixed(0)} KB`
                : `${(attachment.file.size / (1024 * 1024)).toFixed(1)} MB`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAttachment(null)}
            className="p-1 text-gray-500 hover:text-red-400 transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {/* Transcription progress bar */}
      {transcribing && (
        <div className="flex items-center gap-2 px-3 py-2 bg-orange-500/10 border border-orange-500/30 border-b-0 rounded-t-2xl">
          <div className="w-4 h-4 flex-shrink-0">
            <svg className="animate-spin w-4 h-4 text-orange-400" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
          <span className="text-xs text-orange-400 truncate">{transcribeProgress || 'Transcribing...'}</span>
        </div>
      )}

      {/* Main input bar */}
      <form
        onSubmit={handleSubmit}
        className={`flex items-end bg-gray-900 border border-gray-700 ${
          attachment || transcribing ? 'rounded-b-2xl' : 'rounded-2xl'
        } ${transcribing ? 'border-orange-500/30 animate-pulse' : ''} focus-within:border-orange-500/50 transition-colors`}
      >
        {/* Emoji — left side */}
        {hasEmoji && (
          <div className="relative flex-shrink-0 pb-1.5 pl-1">
            <button
              type="button"
              onClick={() => setShowEmoji(!showEmoji)}
              className="p-2 text-gray-500 hover:text-orange-400 transition-colors rounded-full hover:bg-gray-800"
              title="Emoji"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M15.182 15.182a4.5 4.5 0 01-6.364 0M21 12a9 9 0 11-18 0 9 9 0 0118 0zM9.75 9.75c0 .414-.168.75-.375.75S9 10.164 9 9.75 9.168 9 9.375 9s.375.336.375.75zm-.375 0h.008v.015h-.008V9.75zm5.625 0c0 .414-.168.75-.375.75s-.375-.336-.375-.75.168-.75.375-.75.375.336.375.75zm-.375 0h.008v.015h-.008V9.75z" />
              </svg>
            </button>
            {showEmoji && (
              <EmojiPicker
                onSelect={handleEmojiSelect}
                onClose={() => setShowEmoji(false)}
              />
            )}
          </div>
        )}

        {/* Textarea — center */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled}
          rows={1}
          className="flex-1 bg-transparent px-3 py-3 text-white placeholder-gray-500 focus:outline-none text-sm resize-none leading-6 min-w-0"
          style={{ overflowY: 'hidden' }}
        />

        {/* Right side actions */}
        <div className="flex items-center flex-shrink-0 pb-1.5 pr-1 gap-0.5">
          {/* Paperclip — expands to attachment menu */}
          {(hasFiles || hasLocation) && (
            <div className="relative" ref={attachMenuRef}>
              <button
                type="button"
                onClick={() => setShowAttachMenu(!showAttachMenu)}
                className={`p-2 transition-colors rounded-full hover:bg-gray-800 ${
                  showAttachMenu ? 'text-orange-400 rotate-45' : 'text-gray-500 hover:text-orange-400'
                }`}
                title="Attach"
                style={{ transition: 'transform 0.2s, color 0.2s' }}
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M18.375 12.739l-7.693 7.693a4.5 4.5 0 01-6.364-6.364l10.94-10.94A3 3 0 1119.5 7.372L8.552 18.32m.009-.01l-.01.01m5.699-9.941l-7.81 7.81a1.5 1.5 0 002.112 2.13" />
                </svg>
              </button>

              {/* Attachment popup menu */}
              {showAttachMenu && (
                <div className="absolute bottom-full right-0 mb-2 bg-gray-800 border border-gray-700 rounded-xl shadow-xl overflow-hidden min-w-[180px] z-50">
                  {hasFiles && (
                    <FileAttachment
                      onAttach={handleFileAttach}
                      disabled={disabled}
                      renderTrigger={(onClick) => (
                        <button
                          type="button"
                          onClick={onClick}
                          className="w-full flex items-center gap-3 px-4 py-3 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                        >
                          <span className="text-lg">🖼️</span>
                          <span>Photo or File</span>
                        </button>
                      )}
                    />
                  )}
                  {hasLocation && (
                    <LocationPicker
                      onLocation={handleLocation}
                      disabled={disabled}
                      renderTrigger={(onClick) => (
                        <button
                          type="button"
                          onClick={onClick}
                          className="w-full flex items-center gap-3 px-4 py-3 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                        >
                          <span className="text-lg">📍</span>
                          <span>Location</span>
                        </button>
                      )}
                    />
                  )}
                  {hasVoice && (
                    <>
                      <input
                        ref={voiceMemoRef}
                        type="file"
                        accept="audio/*"
                        onChange={handleVoiceMemoSelect}
                        className="sr-only"
                        id="voice-memo-input"
                      />
                      <button
                        type="button"
                        onClick={() => voiceMemoRef.current?.click()}
                        className="w-full flex items-center gap-3 px-4 py-3 text-sm text-gray-300 hover:bg-gray-700 transition-colors"
                      >
                        <span className="text-lg">🎵</span>
                        <span>Voice Memo</span>
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Voice record — right side */}
          {hasVoice && (
            <VoiceRecorder
              onRecorded={handleVoiceRecorded}
              inputServiceUrl={inputServiceUrl}
              onTranscribed={handleTranscribed}
              disabled={disabled}
            />
          )}

          {/* Send button — appears when there's content */}
          {hasValue && (
            <button
              type="submit"
              disabled={disabled}
              className="p-2 text-orange-500 hover:text-orange-400 transition-colors rounded-full hover:bg-gray-800"
              title="Send"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
              </svg>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
