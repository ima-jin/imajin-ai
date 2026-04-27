'use client';

import React, { useState, useRef, useCallback } from 'react';
import { useClipboardUpload } from '@/src/hooks/useClipboardUpload';
import { Avatar } from './Avatar';

interface ImageUploadProps {
  did: string | null;
  currentAvatar?: string;
  onUploadComplete: (url: string) => void;
  onToggleToEmoji?: () => void;
  showEmojiToggle?: boolean;
  /** Override upload endpoint (default: /profile/api/upload) */
  uploadUrl?: string;
  /** FormData field name for the file (default: 'image') */
  fileFieldName?: string;
  /** Max dimension in px for client-side resize (default: 256) */
  maxSize?: number;
  /** Extra FormData fields to append (e.g. context JSON for media service) */
  extraFields?: Record<string, string>;
  /** Section label (default: 'Avatar') */
  label?: string;
  /** Preview shape: 'avatar' renders circular crop, 'banner' renders wide rectangle */
  previewMode?: 'avatar' | 'banner';
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
  uploadUrl = '/profile/api/upload',
  fileFieldName = 'image',
  maxSize: maxSizeProp = 256,
  extraFields,
  label = 'Avatar',
  previewMode = 'avatar',
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
        // Resize to maxSize x maxSize max and compress to 80% JPEG
        const resized = await resizeImage(file, maxSizeProp, 0.8);

        // Create preview from resized blob
        const objectUrl = URL.createObjectURL(resized);
        setPreviewUrl(objectUrl);

        // Upload resized image to server
        const formData = new FormData();
        formData.append(fileFieldName, resized, `upload-${Date.now()}.jpg`);
        formData.append('did', did || '');
        if (extraFields) {
          for (const [k, v] of Object.entries(extraFields)) {
            formData.append(k, v);
          }
        }

        const response = await fetch(uploadUrl, {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [did, onUploadComplete]
  );

  // Clipboard paste support — Ctrl+V / Cmd+V to upload avatar
  useClipboardUpload(
    handleFile,
    { app: 'profile', feature: 'avatar', access: 'public' },
    { enabled: !isUploading }
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
      <label className="block text-sm font-medium text-primary">{label}</label>

      {/* Preview */}
      {previewMode === 'banner' ? (
        displayAvatar ? (
          <div
            className="w-full h-24 bg-cover bg-center mb-2"
            style={{ backgroundImage: `url(${displayAvatar})` }}
          />
        ) : null
      ) : (
        <div className="flex items-center gap-4">
          <Avatar avatar={displayAvatar} size="xl" />
          <div className="flex-1">
            <p className="text-sm text-secondary mb-2">
              {displayAvatar ? 'Current avatar' : 'No avatar set'}
            </p>
          </div>
        </div>
      )}

      {/* Upload Zone */}
      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={openFilePicker}
        className={`
          border-2 border-dashed p-6 text-center cursor-pointer transition
          ${
            isDragging
              ? 'border-[#F59E0B] bg-[#F59E0B]/10'
              : 'border-white/10 hover:border-[#F59E0B]/50 hover:bg-[#F59E0B]/5'
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
            <p className="text-sm text-secondary">Uploading...</p>
          </div>
        ) : (
          <>
            <div className="text-4xl mb-2">📸</div>
            <p className="text-sm text-primary mb-1">
              Drag & drop an image here, or click to browse
            </p>
            <p className="text-xs text-secondary">
              JPG, PNG, GIF, or WebP (max 5MB)
            </p>
          </>
        )}
      </div>

      {/* Error Message */}
      {error && (
        <div className="p-3 bg-error/20 border border-red-800">
          <p className="text-sm text-error">{error}</p>
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
