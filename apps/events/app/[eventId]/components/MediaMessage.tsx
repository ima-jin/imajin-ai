'use client';

import { useState } from 'react';

interface MediaMessageProps {
  assetId: string;
  filename: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  caption?: string;
  isOwn: boolean;
}

const MEDIA_URL = process.env.NEXT_PUBLIC_MEDIA_URL ?? '';

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getFileIcon(mimeType: string): string {
  if (mimeType.includes('pdf')) return '\uD83D\uDCC4';
  if (mimeType.includes('zip') || mimeType.includes('compressed')) return '\uD83D\uDCE6';
  if (mimeType.includes('word') || mimeType.includes('document')) return '\uD83D\uDCDD';
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return '\uD83D\uDCCA';
  if (mimeType.includes('text')) return '\uD83D\uDCC3';
  if (mimeType.includes('video')) return '\uD83C\uDFAC';
  if (mimeType.includes('audio')) return '\uD83C\uDFB5';
  return '\uD83D\uDCCE';
}

export function MediaMessage({ assetId, filename, mimeType, size, width, height, caption, isOwn }: MediaMessageProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const thumbUrl = `${MEDIA_URL}/api/assets/${assetId}?w=400`;
  const fullUrl = `${MEDIA_URL}/api/assets/${assetId}`;
  const isImage = mimeType.startsWith('image/');

  const captionColor = isOwn ? 'text-white/80' : 'text-gray-600 dark:text-gray-400';

  if (isImage) {
    const aspectStyle = width && height ? { aspectRatio: `${width}/${height}` } : {};

    return (
      <>
        <div className="max-w-[260px]">
          <div
            className="cursor-pointer rounded-xl overflow-hidden hover:opacity-90 transition"
            onClick={() => setLightboxOpen(true)}
            style={aspectStyle}
          >
            <img
              src={thumbUrl}
              alt={filename}
              className="w-full h-full object-cover"
              loading="lazy"
            />
          </div>
          {caption && <p className={`text-xs mt-1 ${captionColor}`}>{caption}</p>}
        </div>

        {lightboxOpen && (
          <div
            className="fixed inset-0 bg-black/80 z-50 flex items-center justify-center p-4"
            onClick={() => setLightboxOpen(false)}
          >
            <img
              src={fullUrl}
              alt={filename}
              className="max-w-full max-h-full object-contain rounded-lg"
              onClick={(e) => e.stopPropagation()}
            />
            <button
              className="absolute top-4 right-4 text-white text-3xl hover:text-gray-300 leading-none"
              onClick={() => setLightboxOpen(false)}
              aria-label="Close"
            >
              &times;
            </button>
          </div>
        )}
      </>
    );
  }

  const fileIconBg = isOwn ? 'bg-white/20' : 'bg-gray-100 dark:bg-gray-700';
  const fileNameColor = isOwn ? 'text-white' : 'text-gray-800 dark:text-gray-200';
  const fileSizeColor = isOwn ? 'text-white/60' : 'text-gray-500 dark:text-gray-400';

  return (
    <div className="max-w-[260px]">
      <a
        href={fullUrl}
        download={filename}
        className={`flex items-center gap-3 p-3 rounded-xl transition ${fileIconBg} hover:opacity-80`}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-2xl flex-shrink-0">{getFileIcon(mimeType)}</span>
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium truncate ${fileNameColor}`}>{filename}</p>
          <p className={`text-xs ${fileSizeColor}`}>{formatFileSize(size)}</p>
        </div>
        <svg className={`w-4 h-4 flex-shrink-0 ${isOwn ? 'text-white/60' : 'text-gray-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
        </svg>
      </a>
      {caption && <p className={`text-xs mt-1 ${captionColor}`}>{caption}</p>}
    </div>
  );
}
