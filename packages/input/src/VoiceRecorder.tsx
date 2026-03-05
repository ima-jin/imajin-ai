import React, { useState, useRef, useCallback, useEffect } from 'react';

export interface VoiceRecorderProps {
  /** Called with the recorded audio blob when recording stops */
  onRecorded: (blob: Blob, durationMs: number) => void | Promise<void>;
  /** Input service URL for transcription */
  inputServiceUrl?: string;
  /** Called with transcribed text */
  onTranscribed?: (text: string) => void;
  disabled?: boolean;
}

type RecordingState = 'idle' | 'recording' | 'processing';

/**
 * Get the best supported audio MIME type for recording.
 * Opus in WebM is preferred (small, high quality).
 * Falls back to AAC in MP4 for Safari.
 */
function getSupportedMimeType(): string {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=aac',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return ''; // Browser default
}

export function VoiceRecorder({
  onRecorded,
  inputServiceUrl,
  onTranscribed,
  disabled = false,
}: VoiceRecorderProps) {
  const [state, setState] = useState<RecordingState>('idle');
  const [durationMs, setDurationMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
      }
    };
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 16000,
        },
      });
      streamRef.current = stream;

      const mimeType = getSupportedMimeType();
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 32000, // ~240KB/min compressed
      });

      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        // Stop all tracks
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;

        const duration = Date.now() - startTimeRef.current;
        const blob = new Blob(chunksRef.current, {
          type: mimeType || 'audio/webm',
        });

        // If we have an input service URL and a transcription callback, send for transcription
        if (inputServiceUrl && onTranscribed) {
          setState('processing');
          try {
            const formData = new FormData();
            formData.append('file', blob, `recording.${mimeType.includes('mp4') ? 'm4a' : 'webm'}`);

            const res = await fetch(`${inputServiceUrl}/api/transcribe`, {
              method: 'POST',
              body: formData,
              credentials: 'include',
            });

            if (res.ok) {
              const data = await res.json();
              onTranscribed(data.text);
            } else {
              setError('Transcription failed');
            }
          } catch {
            setError('Could not reach transcription service');
          }
        }

        onRecorded(blob, duration);
        setState('idle');
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250); // Collect data every 250ms
      startTimeRef.current = Date.now();
      setState('recording');

      // Duration timer
      timerRef.current = setInterval(() => {
        setDurationMs(Date.now() - startTimeRef.current);
      }, 100);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'NotAllowedError') {
        setError('Microphone access denied');
      } else {
        setError('Could not access microphone');
      }
    }
  }, [inputServiceUrl, onRecorded, onTranscribed]);

  const stopRecording = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.stop();
    }
  }, []);

  const formatDuration = (ms: number) => {
    const secs = Math.floor(ms / 1000);
    const mins = Math.floor(secs / 60);
    const remSecs = secs % 60;
    return `${mins}:${remSecs.toString().padStart(2, '0')}`;
  };

  if (state === 'processing') {
    return (
      <div className="flex items-center gap-2">
        <div className="animate-spin w-4 h-4 border-2 border-orange-500 border-t-transparent rounded-full" />
        <span className="text-xs text-gray-400">Transcribing...</span>
      </div>
    );
  }

  if (state === 'recording') {
    return (
      <button
        type="button"
        onClick={stopRecording}
        className="flex items-center gap-2 px-3 py-2 bg-red-500/20 border border-red-500/50 text-red-400 rounded-lg hover:bg-red-500/30 transition-colors"
        title="Stop recording"
      >
        <span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
        <span className="text-xs font-mono">{formatDuration(durationMs)}</span>
        <span className="text-xs">⏹</span>
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={startRecording}
        disabled={disabled}
        className="p-2 text-gray-500 hover:text-orange-400 disabled:opacity-40 transition-colors"
        title="Record voice"
      >
        🎙️
      </button>
      {error && (
        <div className="absolute bottom-full mb-1 left-0 text-xs text-red-400 whitespace-nowrap bg-gray-900 px-2 py-1 rounded">
          {error}
        </div>
      )}
    </div>
  );
}
