'use client';

import { useState, useRef, useEffect, useCallback } from 'react';

type RecordingState = 'idle' | 'recording' | 'processing';

interface VoiceRecorderProps {
  onRecordingComplete: (blob: Blob, durationMs: number) => void;
  onCancel: () => void;
  onRecordingStart?: () => void;
  disabled?: boolean;
}

const WAVEFORM_BARS = 20;

export function VoiceRecorder({ onRecordingComplete, onCancel, onRecordingStart, disabled }: VoiceRecorderProps) {
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

  const stopRecording = useCallback((cancel = false) => {
    stopAnimation();
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      if (cancel) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.stop();
        streamRef.current?.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        setState('idle');
        setElapsedMs(0);
        setWaveform(Array(WAVEFORM_BARS).fill(0));
        onCancel();
      } else {
        recorder.stop();
      }
    }
  }, [onCancel]);

  const startRecording = useCallback(async () => {
    if (state !== 'idle') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const audioCtx = new AudioContext();
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
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        const durationMs = Date.now() - startTimeRef.current;
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
        setState('processing');
        setWaveform(Array(WAVEFORM_BARS).fill(0));
        onRecordingComplete(blob, durationMs);
      };

      recorder.start(100);
      startTimeRef.current = Date.now();
      setState('recording');
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
    } catch {
      onCancel();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, onRecordingComplete, onCancel, onRecordingStart]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      stopAnimation();
      streamRef.current?.getTracks().forEach(t => t.stop());
    };
  }, []);

  const formatTime = (ms: number) => {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  };

  // Simple click-to-toggle
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
