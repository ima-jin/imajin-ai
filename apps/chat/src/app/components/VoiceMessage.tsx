'use client';

import { useState, useRef, useEffect } from 'react';

interface VoiceMessageProps {
  assetId: string;
  transcript: string;
  durationMs: number;
  waveform?: number[];
  isOwn: boolean;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

const MEDIA_URL = process.env.NEXT_PUBLIC_MEDIA_URL ?? '';

export function VoiceMessage({ assetId, transcript, durationMs, waveform, isOwn }: VoiceMessageProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const animFrameRef = useRef<number | null>(null);

  const audioSrc = `${MEDIA_URL}/api/assets/${assetId}`;
  const totalDuration = durationMs / 1000;

  const updateProgress = () => {
    const audio = audioRef.current;
    if (!audio) return;
    const dur = audio.duration || totalDuration;
    setCurrentTime(audio.currentTime);
    setProgress(dur > 0 ? audio.currentTime / dur : 0);
    if (!audio.paused) {
      animFrameRef.current = requestAnimationFrame(updateProgress);
    }
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play();
      setIsPlaying(true);
      animFrameRef.current = requestAnimationFrame(updateProgress);
    } else {
      audio.pause();
      setIsPlaying(false);
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    }
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setProgress(0);
    setCurrentTime(0);
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
  };

  const handleProgressClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    const dur = audio.duration || totalDuration;
    audio.currentTime = ratio * dur;
    setProgress(ratio);
  };

  useEffect(() => {
    return () => {
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
    };
  }, []);

  const displayTime = currentTime > 0 ? formatDuration(currentTime * 1000) : formatDuration(durationMs);

  const accentColor = isOwn ? 'bg-white/30' : 'bg-orange-500';
  const progressBg = isOwn ? 'bg-white/20' : 'bg-gray-200 dark:bg-gray-600';
  const buttonColor = isOwn ? 'bg-white/20 hover:bg-white/30 text-white' : 'bg-orange-500 hover:bg-orange-600 text-white';
  const timeColor = isOwn ? 'text-white/70' : 'text-gray-500 dark:text-gray-400';
  const transcriptColor = isOwn ? 'text-white/80' : 'text-gray-600 dark:text-gray-400';
  const transcriptBtnColor = isOwn ? 'text-white/60 hover:text-white/90' : 'text-gray-400 hover:text-gray-600 dark:hover:text-gray-200';

  return (
    <div className="min-w-[200px] max-w-[280px]">
      <audio ref={audioRef} src={audioSrc} onEnded={handleEnded} preload="metadata" />

      {/* Player row */}
      <div className="flex items-center gap-2">
        <button
          onClick={togglePlay}
          className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center transition ${buttonColor}`}
          aria-label={isPlaying ? 'Pause' : 'Play'}
        >
          {isPlaying ? (
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="4" width="4" height="16" />
              <rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg className="w-3 h-3 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <div className="flex-1 flex flex-col gap-1">
          {/* Waveform / progress bar */}
          {waveform && waveform.length > 0 ? (
            <div
              role="slider"
              tabIndex={0}
              aria-label="Audio progress"
              className="relative h-8 flex items-center gap-px cursor-pointer"
              onClick={handleProgressClick}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') (e.currentTarget as HTMLDivElement).click(); }}
            >
              {waveform.map((amp, i) => {
                const barProgress = i / waveform.length;
                const filled = barProgress <= progress;
                const height = Math.max(3, Math.round(amp * 28));
                return (
                  <div
                    key={i}
                    className={`w-[2px] rounded-full transition-colors ${
                      filled
                        ? isOwn ? 'bg-white' : 'bg-orange-500'
                        : isOwn ? 'bg-white/30' : 'bg-gray-300 dark:bg-gray-600'
                    }`}
                    style={{ height: `${height}px` }}
                  />
                );
              })}
            </div>
          ) : (
            <div
              role="slider"
              tabIndex={0}
              aria-label="Audio progress"
              className={`h-1.5 rounded-full cursor-pointer ${progressBg}`}
              onClick={handleProgressClick}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') (e.currentTarget as HTMLDivElement).click(); }}
            >
              <div
                className={`h-full rounded-full transition-all ${isOwn ? 'bg-white' : 'bg-orange-500'}`}
                style={{ width: `${progress * 100}%` }}
              />
            </div>
          )}

          <span className={`text-xs ${timeColor}`}>{displayTime}</span>
        </div>
      </div>

      {/* Transcript */}
      {transcript && (
        <div className="mt-1.5">
          <button
            onClick={() => setShowTranscript(!showTranscript)}
            className={`text-xs ${transcriptBtnColor} transition flex items-center gap-1`}
          >
            <svg className={`w-3 h-3 transition-transform ${showTranscript ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
            Transcript
          </button>
          {showTranscript && (
            <p className={`text-xs mt-1 italic ${transcriptColor}`}>{transcript}</p>
          )}
        </div>
      )}
    </div>
  );
}
