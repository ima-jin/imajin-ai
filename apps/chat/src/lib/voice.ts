const INPUT_URL = process.env.NEXT_PUBLIC_INPUT_URL ?? '';

export async function sendVoiceMessage(audioBlob: Blob): Promise<{
  assetId: string;
  transcript: string;
  durationMs: number;
}> {
  const startTime = Date.now();

  const uploadForm = new FormData();
  uploadForm.append('file', audioBlob, 'voice.webm');

  const transcribeForm = new FormData();
  transcribeForm.append('file', audioBlob, 'voice.webm');

  const [uploadRes, transcribeRes] = await Promise.all([
    fetch(`${INPUT_URL}/api/upload`, {
      method: 'POST',
      body: uploadForm,
      credentials: 'include',
    }),
    fetch(`${INPUT_URL}/api/transcribe`, {
      method: 'POST',
      body: transcribeForm,
      credentials: 'include',
    }),
  ]);

  if (!uploadRes.ok) {
    const err = await uploadRes.json().catch(() => ({}));
    throw new Error((err as any).error || 'Voice upload failed');
  }
  if (!transcribeRes.ok) {
    const err = await transcribeRes.json().catch(() => ({}));
    throw new Error((err as any).error || 'Transcription failed');
  }

  const [uploadData, transcribeData] = await Promise.all([
    uploadRes.json(),
    transcribeRes.json(),
  ]);

  return {
    assetId: uploadData.assetId ?? uploadData.id ?? '',
    transcript: transcribeData.transcript ?? transcribeData.text ?? '',
    durationMs: Date.now() - startTime,
  };
}
