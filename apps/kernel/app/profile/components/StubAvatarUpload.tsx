'use client';

import React, { useState, useRef, useCallback } from 'react';
import { Avatar } from './Avatar';

interface StubAvatarUploadProps {
  identityDid: string;
  currentAvatar?: string;
}

/**
 * StubAvatarUpload - Avatar upload widget for stub business profile maintainers.
 * Shows current avatar and a drag-and-drop / click-to-browse upload zone.
 * On success, reloads the page to display the updated avatar.
 */
export function StubAvatarUpload({ identityDid, currentAvatar }: StubAvatarUploadProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resizeImage = useCallback((file: File): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        const maxSize = 256;
        if (width > maxSize || height > maxSize) {
          if (width > height) {
            height = Math.round((height * maxSize) / width);
            width = maxSize;
          } else {
            width = Math.round((width * maxSize) / height);
            height = maxSize;
          }
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error('Canvas toBlob failed'))),
          'image/jpeg',
          0.8
        );
      };
      img.onerror = () => reject(new Error('Failed to load image'));
      img.src = URL.createObjectURL(file);
    });
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(file.type)) {
        setError('Invalid file type. Only JPG, PNG, GIF, and WebP are allowed.');
        return;
      }
      if (file.size > 5 * 1024 * 1024) {
        setError('File too large. Maximum size is 5MB.');
        return;
      }

      setError('');
      setIsUploading(true);

      try {
        const resized = await resizeImage(file);
        setPreviewUrl(URL.createObjectURL(resized));

        const formData = new FormData();
        formData.append('image', resized, `avatar-${Date.now()}.jpg`);

        const encodedDid = encodeURIComponent(identityDid);
        const response = await fetch(`/profile/api/stubs/${encodedDid}/avatar`, {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Upload failed');
        }

        // Reload to show the updated avatar from the server
        window.location.reload();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        setError(message);
        setPreviewUrl(null);
      } finally {
        setIsUploading(false);
      }
    },
    [identityDid, resizeImage]
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) handleFile(files[0]);
    },
    [handleFile]
  );

  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) handleFile(files[0]);
    },
    [handleFile]
  );

  const displayAvatar = previewUrl || currentAvatar;

  return (
    <div className="mt-3 border-t border-sky-800/30 pt-3">
      {!isExpanded ? (
        <div className="flex items-center justify-center gap-3">
          {displayAvatar && <Avatar avatar={displayAvatar} size="sm" />}
          <button
            type="button"
            onClick={() => setIsExpanded(true)}
            className="text-xs text-sky-400 hover:text-sky-300 hover:underline"
          >
            {displayAvatar ? '🖼 Change avatar' : '🖼 Add avatar'}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {displayAvatar && (
            <div className="flex justify-center">
              <Avatar avatar={displayAvatar} size="md" />
            </div>
          )}

          <div
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClick={() => fileInputRef.current?.click()}
            className={`
              border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition
              ${isDragging
                ? 'border-[#F59E0B] bg-[#F59E0B]/10'
                : 'border-sky-800/60 hover:border-sky-600/80 hover:bg-sky-900/10'
              }
              ${isUploading ? 'opacity-50 pointer-events-none' : ''}
            `}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/jpeg,image/png,image/gif,image/webp"
              onChange={onFileInputChange}
              className="hidden"
            />
            {isUploading ? (
              <div className="flex flex-col items-center gap-1">
                <div className="inline-block animate-spin rounded-full h-5 w-5 border-b-2 border-[#F59E0B]" />
                <p className="text-xs text-gray-400">Uploading...</p>
              </div>
            ) : (
              <>
                <p className="text-xs text-sky-300">Drag & drop or click to browse</p>
                <p className="text-xs text-gray-500 mt-0.5">JPG, PNG, GIF, or WebP · max 5MB</p>
              </>
            )}
          </div>

          {error && (
            <p className="text-xs text-red-400 text-center">{error}</p>
          )}

          <div className="text-center">
            <button
              type="button"
              onClick={() => { setIsExpanded(false); setError(''); setPreviewUrl(null); }}
              className="text-xs text-gray-500 hover:text-gray-400"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
