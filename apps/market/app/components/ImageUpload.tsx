'use client';

import { useState, useRef, useCallback } from 'react';

const MAX_IMAGES = 8;

interface ImageUploadProps {
  images: string[];
  onChange: (images: string[]) => void;
}

export function ImageUpload({ images, onChange }: ImageUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      const remaining = MAX_IMAGES - images.length;
      if (remaining <= 0) {
        setError(`Maximum ${MAX_IMAGES} images allowed.`);
        return;
      }

      const allowed = fileArray.slice(0, remaining);
      const invalid = fileArray.find(
        (f) => !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(f.type)
      );
      if (invalid) {
        setError('Only JPG, PNG, GIF, and WebP images are allowed.');
        return;
      }

      setError('');
      const readers = allowed.map(
        (file) =>
          new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = (e) => resolve(e.target?.result as string);
            reader.readAsDataURL(file);
          })
      );

      Promise.all(readers).then((dataUrls) => {
        onChange([...images, ...dataUrls]);
      });
    },
    [images, onChange]
  );

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      addFiles(e.dataTransfer.files);
    },
    [addFiles]
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
      if (e.target.files && e.target.files.length > 0) {
        addFiles(e.target.files);
        // Reset input so same files can be re-selected
        e.target.value = '';
      }
    },
    [addFiles]
  );

  const removeImage = useCallback(
    (index: number) => {
      onChange(images.filter((_, i) => i !== index));
    },
    [images, onChange]
  );

  const isFull = images.length >= MAX_IMAGES;

  return (
    <div>
      {/* Thumbnails */}
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-3">
          {images.map((src, i) => (
            <div key={i} className="relative w-20 h-20 rounded-lg overflow-hidden border border-gray-700 group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={src} alt={`Image ${i + 1}`} className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/70 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition hover:bg-red-600"
                aria-label="Remove image"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Drop zone */}
      {!isFull && (
        <div
          onDrop={onDrop}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          role="button"
          tabIndex={0}
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click();
          }}
          className={`
            border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition
            ${isDragging
              ? 'border-blue-500 bg-blue-500/10'
              : 'border-gray-600 hover:border-blue-500/50 hover:bg-blue-500/5'}
          `}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            multiple
            onChange={onFileInputChange}
            className="hidden"
          />
          <p className="text-sm text-gray-400 mb-1">Drop images here or click to browse</p>
          <p className="text-xs text-gray-500">
            {images.length} of {MAX_IMAGES} images · JPG, PNG, GIF, WebP
          </p>
        </div>
      )}

      {isFull && (
        <p className="text-xs text-gray-500 mt-1">{MAX_IMAGES} of {MAX_IMAGES} images (maximum reached)</p>
      )}

      {error && (
        <p className="mt-2 text-sm text-red-400">{error}</p>
      )}
    </div>
  );
}
