'use client';

import { useState, useCallback } from 'react';
import { useChatConfig } from '../ChatProvider';

interface UseVoiceRecordingResult {
  sendVoice: (blob: Blob) => Promise<{ assetId: string; transcript: string; durationMs: number }>;
  isSending: boolean;
  error: Error | null;
}

export function useVoiceRecording(): UseVoiceRecordingResult {
  const { inputUrl } = useChatConfig();
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const sendVoice = useCallback(async (blob: Blob) => {
    setIsSending(true);
    setError(null);
    const startTime = Date.now();
    try {
      const uploadForm = new FormData();
      uploadForm.append('file', blob, 'voice.webm');
      uploadForm.append('context', JSON.stringify({ app: 'chat', feature: 'voice' }));

      const transcribeForm = new FormData();
      transcribeForm.append('file', blob, 'voice.webm');

      const [uploadRes, transcribeRes] = await Promise.all([
        fetch(`${inputUrl}/api/upload`, { method: 'POST', body: uploadForm, credentials: 'include' }),
        fetch(`${inputUrl}/api/transcribe`, { method: 'POST', body: transcribeForm, credentials: 'include' }),
      ]);

      if (!uploadRes.ok) {
        const err = await uploadRes.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || 'Voice upload failed');
      }
      if (!transcribeRes.ok) {
        const err = await transcribeRes.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || 'Transcription failed');
      }

      const [uploadData, transcribeData] = await Promise.all([
        uploadRes.json(),
        transcribeRes.json(),
      ]);

      return {
        assetId: (uploadData.assetId ?? uploadData.id ?? '') as string,
        transcript: (transcribeData.transcript ?? transcribeData.text ?? '') as string,
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
