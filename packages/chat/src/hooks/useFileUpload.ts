'use client';

import { useState, useCallback } from 'react';
import { useChatConfig } from '../ChatProvider';

interface UseFileUploadResult {
  uploadFile: (file: File) => Promise<{ assetId: string; width?: number; height?: number }>;
  isUploading: boolean;
  error: Error | null;
}

export function useFileUpload(): UseFileUploadResult {
  const { mediaUrl } = useChatConfig();
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const uploadFile = useCallback(async (file: File) => {
    setIsUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch(`${mediaUrl}/api/assets`, {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || 'Upload failed');
      }
      const data = await res.json();
      return {
        assetId: (data.assetId ?? data.id ?? '') as string,
        width: data.width as number | undefined,
        height: data.height as number | undefined,
      };
    } catch (err) {
      const e = err instanceof Error ? err : new Error('Upload failed');
      setError(e);
      throw e;
    } finally {
      setIsUploading(false);
    }
  }, [mediaUrl]);

  return { uploadFile, isUploading, error };
}
