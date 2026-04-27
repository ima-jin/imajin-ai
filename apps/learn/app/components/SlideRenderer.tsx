'use client';

import { useState, useEffect, useCallback } from 'react';
import { simpleMarkdown } from '../lib/markdown';
import { PrimitiveMatrix } from './PrimitiveMatrix';

export interface SlideLesson {
  id: string;
  title: string;
  content: string | null;
  metadata: {
    layout?: 'center' | 'left' | 'split';
    subtitle?: string;
    items?: string[];
    table?: { headers: string[]; rows: string[][] };
    stats?: { label: string; value: string }[];
    compare?: {
      headers: string[];
      rows: { cells: string[]; highlight?: boolean }[];
    };
    cta?: { text: string; href: string };
    matrix?: { active?: [number, number][] };
  } | null;
}

interface SlideRendererProps {
  slides: SlideLesson[];
  initialIndex?: number;
  onExit: () => void;
}

export function SlideRenderer({ slides, initialIndex = 0, onExit }: SlideRendererProps) {
  const [current, setCurrent] = useState(Math.max(0, Math.min(initialIndex, slides.length - 1)));
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [touchStartY, setTouchStartY] = useState<number | null>(null);

  const goTo = useCallback((index: number) => {
    if (index < 0 || index >= slides.length) return;
    setCurrent(index);
  }, [slides.length]);

  const next = useCallback(() => goTo(current + 1), [current, goTo]);
  const prev = useCallback(() => goTo(current - 1), [current, goTo]);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        next();
      } else if (e.key === 'ArrowLeft' || e.key === 'Backspace') {
        e.preventDefault();
        prev();
      } else if (e.key === 'Home') {
        e.preventDefault();
        goTo(0);
      } else if (e.key === 'End') {
        e.preventDefault();
        goTo(slides.length - 1);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onExit();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [next, prev, goTo, onExit, slides.length]);

  // Hide the root layout NavBar when renderer is mounted
  useEffect(() => {
    const nav = document.querySelector('nav');
    if (nav) nav.style.display = 'none';
    return () => {
      if (nav) nav.style.display = '';
    };
  }, []);

  if (!slides.length) return null;

  const slide = slides[current];
  const meta = slide?.metadata || {};
  const layout = meta?.layout || 'left';
  const isCenter = layout === 'center';
  const hasMatrix = !!meta?.matrix;

  return (
    <div
      className="fixed inset-0 bg-[#0a0a0a] text-primary select-none z-50"
      onTouchStart={(e) => {
        setTouchStart(e.touches[0].clientX);
        setTouchStartY(e.touches[0].clientY);
      }}
      onTouchEnd={(e) => {
        if (touchStart === null) return;
        const diffX = e.changedTouches[0].clientX - touchStart;
        const diffY = e.changedTouches[0].clientY - (touchStartY ?? 0);
        if (Math.abs(diffX) > 50 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
          diffX > 0 ? prev() : next();
        }
        setTouchStart(null);
        setTouchStartY(null);
      }}
    >
      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 h-14 flex items-center justify-between px-8 md:px-16 bg-[#0a0a0a] z-10">
        <div className="text-primary/40 text-sm tracking-widest font-medium">IMAJIN</div>
        <div className="flex items-center gap-5">
          <button
            onClick={onExit}
            className="text-primary/25:text-primary/60 text-xs tracking-widest transition-colors"
          >
            ESC
          </button>
          <div className="text-primary/40 text-sm font-mono">
            {current + 1} / {slides.length}
          </div>
        </div>
      </div>

      {/* Matrix split layout */}
      {hasMatrix ? (
        <div className="absolute inset-0 top-14 bottom-14 flex flex-col md:flex-row">
          {/* Matrix — sticky left panel */}
          <div className="md:w-[420px] shrink-0 flex items-center justify-center px-8 py-6 md:border-r md:border-white/10">
            <PrimitiveMatrix active={meta.matrix?.active} />
          </div>
          {/* Content — right panel, scrollable */}
          <div className="flex-1 overflow-y-auto px-8 md:px-12 py-8 md:py-12">
            <div className="max-w-xl" key={current}>
              <h1 className="text-3xl md:text-5xl font-bold tracking-tight mb-4 leading-tight">
                {slide.title}
              </h1>
              {slide.content && (
                <div
                  className="text-lg text-primary/70 leading-relaxed"
                  dangerouslySetInnerHTML={{ __html: simpleMarkdown(slide.content) }}
                />
              )}
            </div>
          </div>
        </div>
      ) : (

      /* Standard slide layout */
      <div className="absolute inset-0 top-14 bottom-14 overflow-y-auto px-8 md:px-16 py-8 md:py-12">
        <div className={`min-h-full flex ${isCenter ? 'items-center justify-center' : 'items-center'}`}>
          <div
            className={`w-full max-w-3xl mx-auto ${isCenter ? 'text-center' : ''}`}
            key={current}
          >
            {/* Title */}
            <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-4 leading-tight">
              {slide.title}
            </h1>

            {/* Subtitle */}
            {meta?.subtitle && (
              <p className="text-xl text-primary/50 mb-10">{meta.subtitle}</p>
            )}

            {/* Plain markdown content (when no structured data overrides it) */}
            {slide.content && !meta?.items && !meta?.stats && !meta?.compare && (
              <div
                className="text-lg text-primary/70 leading-relaxed"
                dangerouslySetInnerHTML={{ __html: simpleMarkdown(slide.content) }}
              />
            )}

            {/* Items list (numbered) */}
            {meta?.items && (
              <div className={`space-y-6 mt-6 ${isCenter ? 'text-left max-w-2xl mx-auto' : ''}`}>
                {meta.items.map((item, i) => (
                  <div key={i} className="flex gap-4 text-lg md:text-xl">
                    <span className="text-primary/30 font-mono shrink-0">{i + 1}</span>
                    <span className="text-primary/80">{item}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Stats rows */}
            {meta?.stats && (
              <div className="border border-white/10 p-6 mt-8">
                {meta.stats.map((stat, i) => (
                  <div
                    key={i}
                    className="flex justify-between border-b border-white/10 py-3 last:border-0 gap-4"
                  >
                    <span className="text-primary/50">{stat.label}</span>
                    <span className="font-medium text-right">{stat.value}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Comparison table */}
            {meta?.compare && (
              <div className="border border-white/10 p-6 mt-8">
                <div className="flex justify-between py-2 border-b border-white/20 text-sm text-primary/40 uppercase tracking-wider">
                  {meta.compare.headers.map((h, i) => (
                    <span key={i} className={`flex-1 ${i > 0 ? 'text-right' : ''}`}>{h}</span>
                  ))}
                </div>
                {meta.compare.rows.map((row, i) => (
                  <div
                    key={i}
                    className={`flex justify-between py-3 border-b border-white/10 last:border-0 ${ row.highlight ? 'text-primary font-medium' : 'text-primary/60' }`}
                  >
                    {row.cells.map((cell, j) => (
                      <span key={j} className={`flex-1 ${j > 0 ? 'text-right' : ''}`}>{cell}</span>
                    ))}
                  </div>
                ))}
              </div>
            )}

            {/* Generic table */}
            {meta?.table && (
              <div className="border border-white/10 p-6 mt-8 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/20">
                      {meta.table.headers.map((h, i) => (
                        <th
                          key={i}
                          className="py-2 text-left text-primary/40 uppercase tracking-wider text-xs pr-6 font-normal"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {meta.table.rows.map((row, i) => (
                      <tr key={i} className="border-b border-white/10 last:border-0">
                        {row.map((cell, j) => (
                          <td key={j} className={`py-3 pr-6 ${j === 0 ? 'text-primary font-mono' : 'text-primary/50'}`}>
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Content rendered after structured data (if both exist) */}
            {slide.content && (meta?.items || meta?.stats || meta?.compare) && (
              <div
                className="text-primary/40 mt-8 text-lg leading-relaxed"
                dangerouslySetInnerHTML={{ __html: simpleMarkdown(slide.content) }}
              />
            )}

            {/* CTA link */}
            {meta?.cta && (
              <a
                href={meta.cta.href}
                className="mt-10 inline-block text-primary/40:text-primary transition-colors text-lg"
              >
                {meta.cta.text} →
              </a>
            )}
          </div>
        </div>
      </div>
      )}

      {/* Bottom navigation */}
      <div className="absolute bottom-0 left-0 right-0 h-14 flex items-center justify-between px-8 md:px-16 bg-gradient-to-t from-[#0a0a0a] via-[#0a0a0a] to-transparent z-10">
        <button
          onClick={prev}
          disabled={current === 0}
          className="hover:text-primary disabled:opacity-0 text-primary/50 transition-colors px-4 py-2"
        >
          ←
        </button>

        <div className="flex items-center gap-1.5">
          {slides.map((_, i) => (
            <button
              key={i}
              onClick={() => goTo(i)}
              className={`w-2 h-2 rounded-full transition-colors ${ i === current ? 'bg-surface-card/80' : 'bg-surface-card/25:bg-surface-card/50' }`}
            />
          ))}
        </div>

        <button
          onClick={next}
          disabled={current === slides.length - 1}
          className="hover:text-primary disabled:opacity-0 text-primary/50 transition-colors px-4 py-2"
        >
          →
        </button>
      </div>
    </div>
  );
}
