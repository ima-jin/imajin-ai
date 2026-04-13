'use client';

import React, { useState, useRef, useCallback, useEffect } from 'react';

interface GalleryImage {
  id: string;
  url: string;
  caption: string | null;
  sortOrder: number | null;
}

interface StubGalleryProps {
  identityDid: string;
  isMaintainer: boolean;
}

const MAX_GALLERY_IMAGES = 6;

/**
 * StubGallery - Photo gallery for stub business profiles.
 * Maintainers can upload (max 6) and delete images.
 * Non-maintainers see a read-only grid.
 */
export function StubGallery({ identityDid, isMaintainer }: StubGalleryProps) {
  const [images, setImages] = useState<GalleryImage[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const encodedDid = encodeURIComponent(identityDid);

  const fetchImages = useCallback(async () => {
    try {
      const res = await fetch(`/profile/api/stubs/${encodedDid}/images`);
      if (res.ok) {
        const data = await res.json();
        setImages(data.images || []);
      }
    } catch {
      // silently fail
    } finally {
      setIsLoading(false);
    }
  }, [encodedDid]);

  useEffect(() => {
    fetchImages();
  }, [fetchImages]);

  const resizeImage = useCallback((file: File): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        const maxSize = 1200;
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

        const formData = new FormData();
        formData.append('image', resized, `gallery-${Date.now()}.jpg`);

        const response = await fetch(`/profile/api/stubs/${encodedDid}/images`, {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Upload failed');
        }

        await fetchImages();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Upload failed';
        setError(message);
      } finally {
        setIsUploading(false);
      }
    },
    [encodedDid, resizeImage, fetchImages]
  );

  const handleDelete = useCallback(
    async (imageId: string) => {
      try {
        const response = await fetch(`/profile/api/stubs/${encodedDid}/images/${imageId}`, {
          method: 'DELETE',
        });
        if (!response.ok) {
          const data = await response.json();
          throw new Error(data.error || 'Delete failed');
        }
        setImages(prev => prev.filter(img => img.id !== imageId));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Delete failed';
        setError(message);
      }
    },
    [encodedDid]
  );

  const onFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) handleFile(files[0]);
      // Reset input so the same file can be re-selected
      e.target.value = '';
    },
    [handleFile]
  );

  if (isLoading) return null;
  if (!isMaintainer && images.length === 0) return null;

  const canUpload = isMaintainer && images.length < MAX_GALLERY_IMAGES;

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs text-gray-500 uppercase tracking-wider">Photos</h3>
        {isMaintainer && (
          <span className="text-xs text-gray-600">{images.length}/{MAX_GALLERY_IMAGES}</span>
        )}
      </div>

      {images.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5 mb-2">
          {images.map(image => (
            <div key={image.id} className="relative group aspect-square">
              <img
                src={image.url}
                alt={image.caption || ''}
                className="w-full h-full object-cover rounded"
              />
              {isMaintainer && (
                <button
                  type="button"
                  onClick={() => handleDelete(image.id)}
                  className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity
                             bg-black/70 text-white rounded text-xs px-1.5 py-0.5 hover:bg-red-900/80"
                  title="Remove photo"
                >
                  ✕
                </button>
              )}
              {image.caption && (
                <p className="text-xs text-gray-400 mt-0.5 truncate">{image.caption}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {canUpload && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            onChange={onFileInputChange}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="w-full py-2 border border-dashed border-sky-800/60 rounded-lg text-xs text-sky-400
                       hover:border-sky-600/80 hover:bg-sky-900/10 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isUploading ? (
              <span className="flex items-center justify-center gap-1.5">
                <span className="inline-block animate-spin rounded-full h-3 w-3 border-b-2 border-[#F59E0B]" />
                Uploading...
              </span>
            ) : (
              '+ Add photo'
            )}
          </button>
        </>
      )}

      {error && (
        <p className="text-xs text-red-400 text-center mt-1">{error}</p>
      )}
    </div>
  );
}
