'use client';

import { useEffect, useRef, useState } from 'react';

const PROMO_SEEN_KEY = 'imajin:promo-seen';

function getVideoSrc(assetId: string): string {
  return `/media/api/assets/${assetId}`;
}

function getQualitySource(assetId: string): string {
  if (typeof window === 'undefined') return `${getVideoSrc(assetId)}?quality=720p`;
  const w = window.innerWidth;
  if (w >= 768) return `${getVideoSrc(assetId)}?quality=1080p`;
  if (w >= 480) return `${getVideoSrc(assetId)}?quality=720p`;
  return `${getVideoSrc(assetId)}?quality=360p`;
}

export function PromoVideo() {
  const assetId = process.env.NEXT_PUBLIC_PROMO_VIDEO_ID;
  const videoRef = useRef<HTMLVideoElement>(null);
  const [interacted, setInteracted] = useState(false);
  const [showOverlay, setShowOverlay] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!assetId) return;
    setSrc(getQualitySource(assetId));
  }, [assetId]);

  useEffect(() => {
    if (!assetId || !src) return;
    const video = videoRef.current;
    if (!video) return;

    const seen = localStorage.getItem(PROMO_SEEN_KEY) === 'true';

    if (seen) {
      // Returning visitor — start collapsed
      setCollapsed(true);
      return;
    }

    // First visit: autoplay muted, mark as seen immediately
    video.muted = true;
    video.play().catch(() => {});
    localStorage.setItem(PROMO_SEEN_KEY, 'true');
  }, [assetId, src]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || collapsed) return;

    let timer: ReturnType<typeof setTimeout>;

    function handleEnded() {
      localStorage.setItem(PROMO_SEEN_KEY, 'true');
      timer = setTimeout(() => setCollapsed(true), 5000);
    }

    video.addEventListener('ended', handleEnded);
    return () => {
      video.removeEventListener('ended', handleEnded);
      clearTimeout(timer);
    };
  }, [collapsed]);

  if (!assetId || !src) return null;

  function handleOverlayClick() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    video.currentTime = 0;
    video.play().catch(() => {});
    setShowOverlay(false);
    setInteracted(true);
  }

  function handleWatchAgain() {
    setCollapsed(false);
    setShowOverlay(false);
    setInteracted(true);
    // Let the video element mount, then play
    requestAnimationFrame(() => {
      const video = videoRef.current;
      if (!video) return;
      video.muted = false;
      video.currentTime = 0;
      video.play().catch(() => {});
    });
  }

  // Collapsed state — just a button
  if (collapsed) {
    return (
      <section className="w-full max-w-4xl mx-auto mb-10 px-0 flex justify-center">
        <button
          onClick={handleWatchAgain}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl border border-amber-500/30 bg-amber-500/5 text-amber-400 hover:bg-amber-500/10 hover:border-amber-500/50 transition-colors text-sm"
        >
          <span className="text-lg">▶</span>
          Watch the video
        </button>
      </section>
    );
  }

  return (
    <section className="w-full max-w-4xl mx-auto mb-10 px-0">
      <div className="relative w-full" style={{ aspectRatio: '16/9' }}>
        <video
          ref={videoRef}
          src={src}
          className="w-full h-full rounded-xl object-cover bg-gray-900"
          playsInline
          controls={interacted}
          preload="auto"
        />

        {/* Click-for-sound overlay */}
        {showOverlay && (
          <button
            onClick={handleOverlayClick}
            aria-label="Unmute and play from start"
            className="absolute inset-0 flex items-center justify-center rounded-xl group"
          >
            <span className="flex items-center justify-center w-14 h-14 rounded-full bg-black/40 border border-white/10 text-white/70 text-2xl backdrop-blur-sm transition-all group-hover:bg-black/60 group-hover:text-white group-hover:scale-110">
              🔊
            </span>
          </button>
        )}
      </div>
    </section>
  );
}
