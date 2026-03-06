import React, { useState, useRef, useCallback } from 'react';

export interface FileAttachmentData {
  file: File;
  preview?: string; // Data URL for image preview
  type: 'image' | 'video' | 'audio' | 'document';
}

export interface FileAttachmentProps {
  onAttach: (attachment: FileAttachmentData) => void;
  onRemove?: () => void;
  /** Accepted MIME types (default: images, audio, video, documents) */
  accept?: string;
  /** Max file size in bytes (default: 50MB) */
  maxSize?: number;
  disabled?: boolean;
  /** Custom trigger renderer — receives click handler to open file picker */
  renderTrigger?: (onClick: () => void) => React.ReactNode;
}

const DEFAULT_ACCEPT = 'image/*,audio/*,video/*,.pdf,.doc,.docx,.txt,.md';
const DEFAULT_MAX_SIZE = 50 * 1024 * 1024; // 50MB

function classifyFile(file: File): FileAttachmentData['type'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return 'document';
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function FileAttachment({
  onAttach,
  onRemove,
  accept = DEFAULT_ACCEPT,
  maxSize = DEFAULT_MAX_SIZE,
  disabled = false,
  renderTrigger,
}: FileAttachmentProps) {
  const [attachment, setAttachment] = useState<FileAttachmentData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(
    (file: File) => {
      setError(null);

      if (file.size > maxSize) {
        setError(`File too large (max ${formatFileSize(maxSize)})`);
        return;
      }

      const type = classifyFile(file);
      const data: FileAttachmentData = { file, type };

      // Generate preview for images
      if (type === 'image') {
        const reader = new FileReader();
        reader.onload = (e) => {
          data.preview = e.target?.result as string;
          setAttachment(data);
          onAttach(data);
        };
        reader.readAsDataURL(file);
      } else {
        setAttachment(data);
        onAttach(data);
      }
    },
    [maxSize, onAttach]
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) processFile(file);
      // Reset input so same file can be selected again
      if (inputRef.current) inputRef.current.value = '';
    },
    [processFile]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const file = e.dataTransfer.files[0];
      if (file) processFile(file);
    },
    [processFile]
  );

  const handleRemove = useCallback(() => {
    setAttachment(null);
    setError(null);
    onRemove?.();
  }, [onRemove]);

  // Show preview if file is attached
  if (attachment) {
    return (
      <div className="flex items-center gap-2 px-2 py-1 bg-gray-800 rounded-lg">
        {attachment.preview ? (
          <img
            src={attachment.preview}
            alt="Preview"
            className="w-8 h-8 rounded object-cover"
          />
        ) : (
          <span className="text-lg">
            {attachment.type === 'audio' ? '🎵' : attachment.type === 'video' ? '🎬' : '📄'}
          </span>
        )}
        <div className="flex-1 min-w-0">
          <p className="text-xs text-gray-300 truncate">{attachment.file.name}</p>
          <p className="text-xs text-gray-500">{formatFileSize(attachment.file.size)}</p>
        </div>
        <button
          type="button"
          onClick={handleRemove}
          className="text-gray-500 hover:text-red-400 text-sm transition-colors"
          title="Remove"
        >
          ✕
        </button>
      </div>
    );
  }

  const openPicker = () => inputRef.current?.click();

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={handleFileSelect}
        disabled={disabled}
        className="sr-only"
      />
      {renderTrigger ? (
        renderTrigger(openPicker)
      ) : (
        <label
          className={`p-2 text-gray-500 hover:text-orange-400 transition-colors cursor-pointer inline-block ${
            disabled ? 'opacity-40 cursor-not-allowed' : ''
          } ${isDragging ? 'text-orange-400' : ''}`}
          title="Attach file"
          tabIndex={0}
          onClick={openPicker}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') openPicker(); }}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
        >
          📎
        </label>
      )}
      {error && (
        <div className="absolute bottom-full mb-1 left-0 text-xs text-red-400 whitespace-nowrap bg-gray-900 px-2 py-1 rounded">
          {error}
        </div>
      )}
    </div>
  );
}
