'use client';

import { useState, useRef, useCallback, ChangeEvent } from 'react';
import { useClipboardUpload } from '@/src/hooks/useClipboardUpload';

interface FileUploadProps {
  conversationId: string;
  onUploadComplete: (data: {
    mediaType: 'image' | 'file';
    mediaPath: string;
    mediaMeta: any;
  }) => void;
  onUploadError: (error: string) => void;
}

export function FileUpload({
  conversationId,
  onUploadComplete,
  onUploadError,
}: FileUploadProps) {
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadFile = useCallback(async (file: File) => {
    setUploading(true);

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch(`/chat/api/conversations/${conversationId}/upload`, {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Upload failed');
      }

      const data = await res.json();
      onUploadComplete(data);

      // Reset input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    } catch (err) {
      onUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  }, [conversationId, onUploadComplete, onUploadError]);

  const handleFileSelect = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) uploadFile(file);
  };

  // Clipboard paste support — Ctrl+V / Cmd+V to upload images in chat
  useClipboardUpload(
    uploadFile,
    { app: 'chat', feature: 'message', entityId: conversationId, access: 'conversation' },
    { enabled: !uploading }
  );

  return (
    <>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*,.pdf,.zip,.txt,.doc,.docx,.xls,.xlsx"
        onChange={handleFileSelect}
        className="hidden"
      />
      <button
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition disabled:opacity-50"
        title="Upload file or image"
      >
        {uploading ? '...' : '📎'}
      </button>
    </>
  );
}
