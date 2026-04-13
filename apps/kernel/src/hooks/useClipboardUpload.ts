'use client';

import { useEffect, useCallback } from 'react';

export interface UploadContext {
  app: string;
  feature?: string;
  entityId?: string;
  access: 'public' | 'private' | 'conversation';
}

/**
 * Universal clipboard paste handler for image uploads.
 *
 * Listens for paste events on the document (or a specific element via ref),
 * extracts image blobs from clipboard data, and calls onFile with both
 * the File and the upload context for .fair access control.
 *
 * Context drives the .fair manifest access level:
 *   - bugs:    { app: 'www', feature: 'bugs', access: 'public' }
 *   - chat:    { app: 'chat', feature: 'message', entityId: conversationId, access: 'conversation' }
 *   - profile: { app: 'profile', feature: 'avatar', access: 'public' }
 *   - media:   { app: 'media', access: 'private' }
 *
 * Usage:
 *   useClipboardUpload(handleFile, { app: 'chat', access: 'conversation' });
 */
export function useClipboardUpload(
  onFile: (file: File) => void,
  context?: UploadContext,
  opts?: { enabled?: boolean; accept?: string[] }
) {
  const enabled = opts?.enabled ?? true;
  const accept = opts?.accept ?? ['image/'];

  const handlePaste = useCallback(
    (e: ClipboardEvent) => {
      if (!enabled) return;

      const items = e.clipboardData?.items;
      if (!items) return;

      for (const item of Array.from(items)) {
        // Check if item matches any accepted mime prefix
        const matches = accept.some((prefix) => item.type.startsWith(prefix));
        if (matches) {
          const file = item.getAsFile();
          if (file) {
            e.preventDefault();
            onFile(file);
            return;
          }
        }
      }
    },
    [onFile, enabled, accept]
  );

  useEffect(() => {
    if (!enabled) return;
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handlePaste, enabled]);

  return { context };
}

/**
 * Helper to build the context FormData field for media upload.
 * Append to your FormData before POSTing to /media/api/assets.
 */
export function appendUploadContext(formData: FormData, context: UploadContext) {
  formData.append('context', JSON.stringify(context));
}
