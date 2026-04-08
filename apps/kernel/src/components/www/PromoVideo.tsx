'use client';

import { useRef, useState } from 'react';

function getVideoSrc(assetId: string): string {
  const base = `/media/api/assets/${assetId}`;
  if (typeof window === 'undefined') return `${base}?quality=720p`;
  const w = window.innerWidth;
  if (w >= 768) return `${base}?quality=1080p`;
  if (w >= 480) return `${base}?quality=720p`;
  return `${base}?quality=360p`;
}

function getPosterSrc(posterId: string): string {
  return `/media/api/assets/${posterId}`;
}

export function PromoVideo() {
  const assetId = process.env.NEXT_PUBLIC_PROMO_VIDEO_ID;
  const posterId = process.env.NEXT_PUBLIC_PROMO_POSTER_ID;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);

  if (!assetId) return null;

  function handlePlay() {
    setPlaying(true);
    requestAnimationFrame(() => {
      const video = videoRef.current;
      if (!video) return;
      video.play().catch(() => {});
    });
  }

  function handleEnded() {
    setPlaying(false);
  }

  // Poster state — show image + play button
  if (!playing) {
    return (
      <section className="w-full max-w-4xl mx-auto mb-10 px-0">
        <button
          onClick={handlePlay}
          className="relative w-full rounded-xl overflow-hidden group cursor-pointer"
          style={{ aspectRatio: '16/9' }}
        >
          <img
            src={posterId ? getPosterSrc(posterId) : `/media/api/assets/${assetId}/og`}
            alt="Imajin — Watch the video"
            className="w-full h-full object-cover bg-gray-900"
          />
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover:bg-black/30 transition-colors">
            <span className="flex items-center justify-center w-16 h-16 rounded-full bg-black/50 border-2 border-white/30 text-white text-3xl backdrop-blur-sm transition-all group-hover:scale-110 group-hover:bg-black/60 group-hover:border-white/50">
              ▶
            </span>
          </div>
        </button>
      </section>
    );
  }

  // Playing state — video with controls
  return (
    <section className="w-full max-w-4xl mx-auto mb-10 px-0">
      <div className="relative w-full" style={{ aspectRatio: '16/9' }}>
        <video
          ref={videoRef}
          src={getVideoSrc(assetId)}
          className="w-full h-full rounded-xl object-cover bg-gray-900"
          playsInline
          controls
          autoPlay
          preload="auto"
          onEnded={handleEnded}
        />
      </div>
    </section>
  );
}
