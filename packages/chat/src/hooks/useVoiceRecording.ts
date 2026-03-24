'use client';

import { useState, useCallback } from 'react';
import { useChatConfig } from '../ChatProvider';

interface UseVoiceRecordingResult {
  sendVoice: (blob: Blob) => Promise<{ assetId: string; transcript: string; durationMs: number }>;
  isSending: boolean;
  error: Error | null;
}

export function useVoiceRecording(): UseVoiceRecordingResult {
  const { inputUrl, mediaUrl } = useChatConfig();
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const sendVoice = useCallback(async (blob: Blob) => {
    setIsSending(true);
    setError(null);
    const startTime = Date.now();
    try {
      // Step 1: Upload audio to get an asset ID
      const uploadForm = new FormData();
      uploadForm.append('file', blob, 'voice.webm');
      uploadForm.append('context', JSON.stringify({ app: 'chat', feature: 'voice' }));

      const uploadRes = await fetch(`${inputUrl}/api/upload`, {
        method: 'POST',
        body: uploadForm,
        credentials: 'include',
      });

      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || 'Voice upload failed');
      }

      const uploadData = await uploadRes.json();
      const assetId = (uploadData.assetId ?? uploadData.id ?? '') as string;

      // Step 2: Transcribe the stored asset via media service
      let transcript = '';
      if (assetId && mediaUrl) {
        try {
          const transcribeRes = await fetch(`${mediaUrl}/api/assets/${assetId}/transcribe`, {
            credentials: 'include',
          });
          if (transcribeRes.ok) {
            const transcribeData = await transcribeRes.json();
            transcript = (transcribeData.transcript?.text ?? transcribeData.text ?? '') as string;
          }
        } catch {
          // Transcription is best-effort — voice message still sends without it
        }
      }

      return {
        assetId,
        transcript,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      const e = err instanceof Error ? err : new Error('Voice send failed');
      setError(e);
      throw e;
    } finally {
      setIsSending(false);
    }
  }, [inputUrl]);

  return { sendVoice, isSending, error };
}
