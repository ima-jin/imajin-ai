'use client';

import React, { useState, useRef, useCallback } from 'react';
import { Avatar } from './Avatar';

interface ImageUploadProps {
  did: string | null;
  currentAvatar?: string;
  onUploadComplete: (url: string) => void;
  onToggleToEmoji?: () => void;
  showEmojiToggle?: boolean;
}

/**
 * ImageUpload component - drag & drop + click to browse
 * Shows preview of uploaded image (circular crop preview)
 * Supports toggle between emoji and image
 */
export function ImageUpload({
  did,
  currentAvatar,
  onUploadComplete,
  onToggleToEmoji,
  showEmojiToggle = true,
}: ImageUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const resizeImage = useCallback(
    (file: File, maxSize: number, quality: number): Promise<Blob> => {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          let { width, height } = img;

          // Scale down to fit within maxSize x maxSize
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
            quality
          );
        };
        img.onerror = () => reject(new Error('Failed to load image'));
        img.src = URL.createObjectURL(file);
      });
    },
    []
  );

  const handleFile = useCallback(
    async (file: File) => {
      // Validate file type
      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(file.type)) {
        setError('Invalid file type. Only JPG, PNG, GIF, and WebP are allowed.');
        return;
      }

      // Validate file size (5MB)
      if (file.size > 5 * 1024 * 1024) {
        setError('File too large. Maximum size is 5MB.');
        return;
      }

      setError('');
      setIsUploading(true);

      try {
        // Resize to 256x256 max and compress to 80% JPEG
        const resized = await resizeImage(file, 256, 0.8);

        // Create preview from resized blob
        const objectUrl = URL.createObjectURL(resized);
        setPreviewUrl(objectUrl);

        // Upload resized image to server
        const formData = new FormData();
        formData.append('image', resized, `avatar-${Date.now()}.jpg`);
        formData.append('did', did || '');

        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Upload failed');
        }

        const data = await response.json();
        onUploadComplete(data.url);
      } catch (err: any) {
        console.error('Upload error:', err);
        setError(err.message || 'Upload failed');
        setPreviewUrl(null);
      } finally {
        setIsUploading(false);
      }
    },
    [did, onUploadComplete]
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);

      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) {
        handleFile(files[0]);
      }
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
      if (files && files.length > 0) {
        handleFile(files[0]);
      }
    },
    [handleFile]
  );

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const displayAvatar = previewUrl || currentAvatar;

  return (
    <div className="space-y-3">
      <label className="block text-sm font-medium text-gray-300">Avatar</label>

      {/* Preview */}
      <div className="flex items-center gap-4">
        <Avatar avatar={displayAvatar} size="xl" />
        <div className="flex-1">
          <p className="text-sm text-gray-400 mb-2">
            {displayAvatar ? 'Current avatar' : 'No avatar set'}
          </p>
        </div>
      </div>

      {/* Upload Zone */}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={openFilePicker}
        className={`
          border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition
          ${
            isDragging
              ? 'border-[#F59E0B] bg-[#F59E0B]/10'
              : 'border-gray-700 hover:border-[#F59E0B]/50 hover:bg-[#F59E0B]/5'
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
          <div className="flex flex-col items-center gap-2">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-[#F59E0B]"></div>
            <p className="text-sm text-gray-400">Uploading...</p>
          </div>
        ) : (
          <>
            <div className="text-4xl mb-2">📸</div>
            <p className="text-sm text-gray-300 mb-1">
              Drag & drop an image here, or click to browse
            </p>
            <p className="text-xs text-gray-500">
              JPG, PNG, GIF, or WebP (max 5MB)
            </p>
          </>
        )}
      </div>

      {/* Error Message */}
      {error && (
        <div className="p-3 bg-red-900/20 border border-red-800 rounded-lg">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Toggle to Emoji */}
      {showEmojiToggle && onToggleToEmoji && (
        <button
          type="button"
          onClick={onToggleToEmoji}
          className="text-sm text-[#F59E0B] hover:underline"
        >
          Or use an emoji instead →
        </button>
      )}
    </div>
  );
}
