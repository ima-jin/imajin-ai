'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { resolveMediaRef } from '@imajin/media';

const MAX_IMAGES = 8;
const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const MEDIA_URL = process.env.NEXT_PUBLIC_MEDIA_URL || `${SERVICE_PREFIX}media.${DOMAIN}`;

interface ImageUploadProps {
  images: string[];
  onChange: (images: string[]) => void;
}

interface PendingUpload {
  id: string;
  previewUrl: string;
}

export function ImageUpload({ images, onChange }: ImageUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState('');
  const [pending, setPending] = useState<PendingUpload[]>([]);

  // Keep a ref so concurrent uploads see the latest committed images
  const imagesRef = useRef(images);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFile = useCallback(
    async (file: File) => {
      const tempId = `${Date.now()}-${Math.random()}`;
      const previewUrl = URL.createObjectURL(file);

      setPending((prev) => [...prev, { id: tempId, previewUrl }]);
      setError('');

      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('context', JSON.stringify({ app: 'market', access: 'public' }));

        const res = await fetch(`${MEDIA_URL}/api/assets`, {
          method: 'POST',
          credentials: 'include',
          body: formData,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(text || `Upload failed (${res.status})`);
        }

        const data = await res.json();
        const assetId: string = data.id;

        // Use ref so parallel uploads each append to the latest list
        const next = [...imagesRef.current, assetId];
        imagesRef.current = next;
        onChange(next);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed. Please try again.');
      } finally {
        setPending((prev) => prev.filter((p) => p.id !== tempId));
        URL.revokeObjectURL(previewUrl);
      }
    },
    [onChange]
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      const totalSlots = MAX_IMAGES - images.length - pending.length;
      if (totalSlots <= 0) {
        setError(`Maximum ${MAX_IMAGES} images allowed.`);
        return;
      }

      const allowed = fileArray.slice(0, totalSlots);
      const invalid = fileArray.find(
        (f) => !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(f.type)
      );
      if (invalid) {
        setError('Only JPG, PNG, GIF, and WebP images are allowed.');
        return;
      }

      setError('');
      allowed.forEach((file) => uploadFile(file));
    },
    [images.length, pending.length, uploadFile]
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

  const totalCount = images.length + pending.length;
  const isFull = totalCount >= MAX_IMAGES;

  return (
    <div>
      {/* Thumbnails */}
      {(images.length > 0 || pending.length > 0) && (
        <div className="flex flex-wrap gap-2 mb-3">
          {/* Committed images */}
          {images.map((src, i) => {
            const imgUrl = resolveMediaRef(src, 'thumbnail');
            return (
            <div key={src} className="relative w-20 h-20 rounded-lg overflow-hidden border border-gray-700 group">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={imgUrl} alt={`Image ${i + 1}`} className="w-full h-full object-cover" />
              <button
                type="button"
                onClick={() => removeImage(i)}
                className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/70 text-white text-xs flex items-center justify-center opacity-0 group-hover:opacity-100 transition hover:bg-red-600"
                aria-label="Remove image"
              >
                ×
              </button>
            </div>
            );
          })}

          {/* Pending uploads — spinner overlay */}
          {pending.map((p) => (
            <div key={p.id} className="relative w-20 h-20 rounded-lg overflow-hidden border border-gray-700">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.previewUrl} alt="Uploading…" className="w-full h-full object-cover opacity-40" />
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <svg
                  className="w-6 h-6 text-white animate-spin"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                >
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                  />
                </svg>
              </div>
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
            {totalCount} of {MAX_IMAGES} images · JPG, PNG, GIF, WebP
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
