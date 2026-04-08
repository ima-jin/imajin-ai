'use client';

import { useEffect, useRef, useState } from 'react';

const PROMO_SEEN_KEY = 'imajin:promo-seen';

function getVideoSrc(assetId: string): string {
  return `/media/api/assets/${assetId}/content`;
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

    if (!seen) {
      // First visit: autoplay muted
      video.muted = true;
      video.play().catch(() => {});
      localStorage.setItem(PROMO_SEEN_KEY, 'true');
    }
    // Returning visitors: video is visible but not autoplaying, overlay stays
  }, [assetId, src]);

  if (!assetId) return null;
  if (!src) return null;

  function handleOverlayClick() {
    const video = videoRef.current;
    if (!video) return;
    video.muted = false;
    video.currentTime = 0;
    video.play().catch(() => {});
    setShowOverlay(false);
    setInteracted(true);
  }

  return (
    <section className="w-full max-w-4xl mx-auto mb-10 px-0">
      <div className="relative w-full" style={{ aspectRatio: '16/9' }}>
        <video
          ref={videoRef}
          src={src}
          className="w-full h-full rounded-xl object-cover bg-gray-900"
          playsInline
          loop={!interacted}
          controls={interacted}
          preload="metadata"
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
