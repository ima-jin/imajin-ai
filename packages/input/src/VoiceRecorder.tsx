'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

type RecordingState = 'idle' | 'recording' | 'processing';

export interface VoiceRecorderProps {
  /** Called with the recorded audio blob when recording stops */
  onRecordingComplete: (blob: Blob, durationMs: number) => void;
  /** @deprecated Use onRecordingComplete */
  onRecorded?: (blob: Blob, durationMs: number) => void | Promise<void>;
  onCancel: () => void;
  onRecordingStart?: () => void;
  disabled?: boolean;
}

const WAVEFORM_BARS = 20;
const MIN_RECORDING_MS = 300; // Minimum recording duration to avoid empty blobs

export function VoiceRecorder({ onRecordingComplete, onRecorded, onCancel, onRecordingStart, disabled }: VoiceRecorderProps) {
  const handleComplete = onRecordingComplete || onRecorded || (() => {});
  const [state, setState] = useState<RecordingState>('idle');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [waveform, setWaveform] = useState<number[]>(Array(WAVEFORM_BARS).fill(0));

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  const stopAnimation = () => {
    if (animFrameRef.current !== null) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  const cleanup = useCallback(() => {
    stopAnimation();
    streamRef.current?.getTracks().forEach(t => t.stop());
    streamRef.current = null;
    audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    mediaRecorderRef.current = null;
    analyserRef.current = null;
  }, []);

  const stopRecording = useCallback((cancel = false) => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') return;

    if (cancel) {
      // Cancel: clear handlers, stop, cleanup
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
      cleanup();
      setState('idle');
      setElapsedMs(0);
      setWaveform(Array(WAVEFORM_BARS).fill(0));
      onCancel();
      return;
    }

    // Check minimum duration — cancel if too short (prevents 0-byte blobs)
    const elapsed = Date.now() - startTimeRef.current;
    if (elapsed < MIN_RECORDING_MS) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      recorder.stop();
      cleanup();
      setState('idle');
      setElapsedMs(0);
      setWaveform(Array(WAVEFORM_BARS).fill(0));
      onCancel();
      return;
    }

    // Normal stop — let ondataavailable and onstop fire
    stopAnimation();
    recorder.stop();
  }, [onCancel, cleanup]);

  const startRecording = useCallback(async () => {
    if (state !== 'idle') return;
    try {
      console.log('VoiceRecorder: requesting mic access...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('VoiceRecorder: mic access granted, starting recorder');
      streamRef.current = stream;

      const audioCtx = new AudioContext();
      audioCtxRef.current = audioCtx;
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      analyserRef.current = analyser;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        console.log('VoiceRecorder: data chunk received, size:', e.data.size);
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onerror = (e) => {
        console.error('VoiceRecorder: MediaRecorder error:', e);
      };

      recorder.onstop = () => {
        console.log('VoiceRecorder: recorder stopped, chunks:', chunksRef.current.length);
        const durationMs = Date.now() - startTimeRef.current;
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
        console.log('VoiceRecorder: blob size:', blob.size, 'duration:', durationMs);
        cleanup();

        // Don't send empty blobs
        if (blob.size === 0) {
          setState('idle');
          setElapsedMs(0);
          setWaveform(Array(WAVEFORM_BARS).fill(0));
          onCancel();
          return;
        }

        setState('processing');
        setWaveform(Array(WAVEFORM_BARS).fill(0));
        // Fire completion, then reset to idle
        Promise.resolve(handleComplete(blob, durationMs)).finally(() => {
          setState('idle');
          setElapsedMs(0);
        });
      };

      recorder.start(100);
      startTimeRef.current = Date.now();
      setState('recording');
      console.log('VoiceRecorder: state → recording, recorder.state:', recorder.state);
      onRecordingStart?.();

      // Timer
      timerRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startTimeRef.current);
      }, 100);

      // Waveform animation
      const drawWaveform = () => {
        if (!analyserRef.current) return;
        const data = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(data);
        const bars: number[] = [];
        const step = Math.floor(data.length / WAVEFORM_BARS);
        for (let i = 0; i < WAVEFORM_BARS; i++) {
          bars.push(data[i * step] / 255);
        }
        setWaveform(bars);
        animFrameRef.current = requestAnimationFrame(drawWaveform);
      };
      animFrameRef.current = requestAnimationFrame(drawWaveform);
    } catch (err) {
      console.error('VoiceRecorder: failed to start recording:', err);
      cleanup();
      onCancel();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, handleComplete, onCancel, onRecordingStart, cleanup]);

  // Clean up on unmount
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  };

  // Click-to-toggle: click starts, click stops
  const handleClick = () => {
    if (disabled) return;
    if (state === 'idle') {
      startRecording();
    } else if (state === 'recording') {
      stopRecording(false);
    }
  };

  if (state === 'idle') {
    return (
      <button
        onClick={handleClick}
        disabled={disabled}
        className="p-2 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition disabled:opacity-50"
        title="Click to record voice message"
      >
        {'\uD83C\uDFA4'}
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-1 bg-gray-100 dark:bg-gray-800 rounded-2xl px-4 py-2">
      {/* Red dot */}
      <span className="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse flex-shrink-0" />

      {/* Timer */}
      <span className="text-sm font-mono text-red-500 flex-shrink-0 w-10">
        {formatTime(elapsedMs)}
      </span>

      {/* Waveform */}
      <div className="flex items-center gap-px flex-1 h-8">
        {waveform.map((val, i) => (
          <div
            key={i}
            className="flex-1 bg-orange-500 dark:bg-orange-400 rounded-full transition-all duration-75"
            style={{ height: `${Math.max(4, val * 32)}px` }}
          />
        ))}
      </div>

      {state === 'processing' ? (
        <span className="text-xs text-gray-500 flex-shrink-0">Processing...</span>
      ) : (
        <>
          {/* Cancel */}
          <button
            onClick={() => stopRecording(true)}
            className="p-1.5 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg text-gray-500 flex-shrink-0"
            title="Cancel recording"
          >
            {'\u2715'}
          </button>

          {/* Stop & send */}
          <button
            onClick={() => stopRecording(false)}
            className="p-1.5 bg-orange-500 hover:bg-orange-600 text-white rounded-lg flex-shrink-0"
            title="Stop and send"
          >
            {'\u23F9'}
          </button>
        </>
      )}
    </div>
  );
}
