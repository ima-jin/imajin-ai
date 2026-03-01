'use client';

import React, { useState, useRef, useCallback } from 'react';

interface ImageUploadProps {
  currentImage?: string;
  onUploadComplete: (url: string) => void;
}

export function ImageUpload({ currentImage, onUploadComplete }: ImageUploadProps) {
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
      const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
      if (!allowedTypes.includes(file.type)) {
        setError('Invalid file type. Only JPG, PNG, GIF, and WebP are allowed.');
        return;
      }

      if (file.size > 10 * 1024 * 1024) {
        setError('File too large. Maximum size is 10MB.');
        return;
      }

      setError('');
      setIsUploading(true);

      try {
        const resized = await resizeImage(file, 1600, 0.85);
        const objectUrl = URL.createObjectURL(resized);
        setPreviewUrl(objectUrl);

        const formData = new FormData();
        formData.append('image', resized, `event-${Date.now()}.jpg`);

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
    [onUploadComplete, resizeImage]
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

  const displayImage = previewUrl || currentImage;

  return (
    <div>
      <label className="block text-sm font-medium mb-1">Cover Image</label>

      {displayImage && (
        <div className="mb-3 rounded-lg overflow-hidden border border-gray-300 dark:border-gray-600">
          <img
            src={displayImage}
            alt="Cover preview"
            className="w-full h-48 object-cover"
          />
        </div>
      )}

      <div
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onClick={() => fileInputRef.current?.click()}
        className={`
          border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition
          ${isDragging
            ? 'border-orange-500 bg-orange-500/10'
            : 'border-gray-300 dark:border-gray-600 hover:border-orange-500/50 hover:bg-orange-500/5'}
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
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-orange-500"></div>
            <p className="text-sm text-gray-500 dark:text-gray-400">Uploading...</p>
          </div>
        ) : (
          <>
            <div className="text-3xl mb-2">📸</div>
            <p className="text-sm text-gray-600 dark:text-gray-300 mb-1">
              Drag & drop an image here, or click to browse
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              JPG, PNG, GIF, or WebP (max 10MB, resized to 1600px)
            </p>
          </>
        )}
      </div>

      {error && (
        <div className="mt-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        </div>
      )}
    </div>
  );
}
