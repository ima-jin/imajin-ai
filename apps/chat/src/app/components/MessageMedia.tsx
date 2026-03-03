'use client';

import { useState } from 'react';

interface MessageMediaProps {
  mediaType: 'image' | 'file';
  mediaPath: string;
  mediaMeta: {
    originalName?: string;
    size?: number;
    width?: number;
    height?: number;
    thumbnailPath?: string;
    mimeType?: string;
  };
}

export function MessageMedia({ mediaType, mediaPath, mediaMeta }: MessageMediaProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  if (mediaType === 'image') {
    const thumbUrl = mediaMeta.thumbnailPath
      ? `/api/media/chat/${mediaMeta.thumbnailPath}`
      : `/api/media/chat/${mediaPath}`;
    const fullUrl = `/api/media/chat/${mediaPath}`;

    return (
      <>
        <div className="mt-2 cursor-pointer" onClick={() => setLightboxOpen(true)}>
          <img
            src={thumbUrl}
            alt={mediaMeta.originalName || 'Image'}
            className="rounded-lg max-w-[300px] hover:opacity-90 transition"
            loading="lazy"
          />
        </div>

        {/* Lightbox */}
        {lightboxOpen && (
          <div
            className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
            onClick={() => setLightboxOpen(false)}
          >
            <img
              src={fullUrl}
              alt={mediaMeta.originalName || 'Image'}
              className="max-w-full max-h-full object-contain"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              className="absolute top-4 right-4 text-white text-3xl hover:text-gray-300"
              onClick={() => setLightboxOpen(false)}
            >
              ×
            </button>
          </div>
        )}
      </>
    );
  }

  // File display
  const fileUrl = `/api/media/chat/${mediaPath}`;
  const sizeKB = mediaMeta.size ? Math.round(mediaMeta.size / 1024) : 0;
  const sizeDisplay = sizeKB < 1024 ? `${sizeKB} KB` : `${(sizeKB / 1024).toFixed(1)} MB`;

  // Get file icon based on mime type
  const getFileIcon = () => {
    if (mediaMeta.mimeType?.includes('pdf')) return '📄';
    if (mediaMeta.mimeType?.includes('zip')) return '📦';
    if (mediaMeta.mimeType?.includes('word')) return '📝';
    if (mediaMeta.mimeType?.includes('excel') || mediaMeta.mimeType?.includes('spreadsheet')) return '📊';
    if (mediaMeta.mimeType?.includes('text')) return '📃';
    return '📎';
  };

  return (
    <a
      href={fileUrl}
      download={mediaMeta.originalName}
      className="mt-2 flex items-center gap-3 p-3 bg-white/50 dark:bg-gray-900/50 rounded-lg hover:bg-white/70 dark:hover:bg-gray-900/70 transition max-w-[300px]"
    >
      <span className="text-3xl">{getFileIcon()}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium truncate">{mediaMeta.originalName || 'File'}</p>
        <p className="text-xs text-gray-500">{sizeDisplay}</p>
      </div>
      <span className="text-gray-400">↓</span>
    </a>
  );
}
