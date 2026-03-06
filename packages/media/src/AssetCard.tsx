import React from 'react';

export interface AssetCardProps {
  id: string;
  type: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  thumbPath?: string;
  createdAt?: string;
  onClick?: (id: string) => void;
}

export function AssetCard({
  id,
  type,
  filename,
  mimeType,
  sizeBytes,
  thumbPath,
  createdAt,
  onClick,
}: AssetCardProps) {
  const sizeLabel = sizeBytes < 1024 * 1024
    ? `${(sizeBytes / 1024).toFixed(1)} KB`
    : `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div
      role="button"
      tabIndex={0}
      className="bg-[#1a1a1a] border border-gray-800 rounded-lg overflow-hidden hover:border-orange-500 transition-colors cursor-pointer"
      onClick={() => onClick?.(id)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick?.(id); }}
    >
      {thumbPath ? (
        <img src={thumbPath} alt={filename} className="w-full h-32 object-cover" />
      ) : (
        <div className="w-full h-32 flex items-center justify-center bg-[#111] text-gray-600 text-4xl">
          {type === 'image' ? '🖼️' : type === 'video' ? '🎬' : type === 'audio' ? '🎵' : '📄'}
        </div>
      )}
      <div className="p-3">
        <p className="text-sm text-white truncate">{filename}</p>
        <p className="text-xs text-gray-500 mt-1">{mimeType} · {sizeLabel}</p>
      </div>
    </div>
  );
}
