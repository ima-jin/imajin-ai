'use client';

import { useState, useEffect, useCallback } from 'react';

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
  } | null;
}

interface SlideRendererProps {
  slides: SlideLesson[];
  initialIndex?: number;
  onExit: () => void;
}

function simpleMarkdown(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h3 class="text-2xl font-bold mb-4 text-white">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-3xl font-bold mb-6 text-white">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-4xl md:text-5xl font-bold tracking-tight mb-8 text-white">$1</h1>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white font-semibold">$1</strong>')
    .replace(/\*(.+?)\*/g, '<em class="italic">$1</em>')
    .replace(/```[\w]*\n([\s\S]*?)```/g, '<pre class="bg-white/5 border border-white/10 rounded-lg p-4 text-sm font-mono text-white/70 overflow-x-auto my-4"><code>$1</code></pre>')
    .replace(/`(.+?)`/g, '<code class="bg-white/10 px-1.5 py-0.5 rounded font-mono text-sm text-white/80">$1</code>')
    .replace(/^\- (.+)$/gm, '<li class="flex gap-3 text-white/70"><span class="text-white/30 mt-1 shrink-0">—</span><span>$1</span></li>')
    .replace(/(<li[\s\S]*?<\/li>\n?)+/g, (m) => `<ul class="space-y-3 my-4">${m}</ul>`)
    .replace(/\n\n/g, '</p><p class="text-lg text-white/70 leading-relaxed mb-4">')
    .replace(/^(?!<[hupuo])(.+)$/gm, '<p class="text-lg text-white/70 leading-relaxed mb-4">$1</p>')
    .replace(/<p[^>]*>\s*<\/p>/g, '');
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

  return (
    <div
      className="fixed inset-0 bg-[#0a0a0a] text-white select-none z-50"
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
        <div className="text-white/40 text-sm tracking-widest font-medium">IMAJIN</div>
        <div className="flex items-center gap-5">
          <button
            onClick={onExit}
            className="text-white/25 hover:text-white/60 text-xs tracking-widest transition-colors"
          >
            ESC
          </button>
          <div className="text-white/40 text-sm font-mono">
            {current + 1} / {slides.length}
          </div>
        </div>
      </div>

      {/* Slide content */}
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
              <p className="text-xl text-white/50 mb-10">{meta.subtitle}</p>
            )}

            {/* Plain markdown content (when no structured data overrides it) */}
            {slide.content && !meta?.items && !meta?.stats && !meta?.compare && (
              <div
                className="text-lg text-white/70 leading-relaxed"
                dangerouslySetInnerHTML={{ __html: simpleMarkdown(slide.content) }}
              />
            )}

            {/* Items list (numbered) */}
            {meta?.items && (
              <div className={`space-y-6 mt-6 ${isCenter ? 'text-left max-w-2xl mx-auto' : ''}`}>
                {meta.items.map((item, i) => (
                  <div key={i} className="flex gap-4 text-lg md:text-xl">
                    <span className="text-white/30 font-mono shrink-0">{i + 1}</span>
                    <span className="text-white/80">{item}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Stats rows */}
            {meta?.stats && (
              <div className="border border-white/10 rounded-lg p-6 mt-8">
                {meta.stats.map((stat, i) => (
                  <div
                    key={i}
                    className="flex justify-between border-b border-white/10 py-3 last:border-0 gap-4"
                  >
                    <span className="text-white/50">{stat.label}</span>
                    <span className="font-medium text-right">{stat.value}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Comparison table */}
            {meta?.compare && (
              <div className="border border-white/10 rounded-lg p-6 mt-8">
                <div className="flex justify-between py-2 border-b border-white/20 text-sm text-white/40 uppercase tracking-wider">
                  {meta.compare.headers.map((h, i) => (
                    <span key={i} className={`flex-1 ${i > 0 ? 'text-right' : ''}`}>{h}</span>
                  ))}
                </div>
                {meta.compare.rows.map((row, i) => (
                  <div
                    key={i}
                    className={`flex justify-between py-3 border-b border-white/10 last:border-0 ${
                      row.highlight ? 'text-white font-medium' : 'text-white/60'
                    }`}
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
              <div className="border border-white/10 rounded-lg p-6 mt-8 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/20">
                      {meta.table.headers.map((h, i) => (
                        <th
                          key={i}
                          className="py-2 text-left text-white/40 uppercase tracking-wider text-xs pr-6 font-normal"
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
                          <td key={j} className={`py-3 pr-6 ${j === 0 ? 'text-white font-mono' : 'text-white/50'}`}>
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
                className="text-white/40 mt-8 text-lg leading-relaxed"
                dangerouslySetInnerHTML={{ __html: simpleMarkdown(slide.content) }}
              />
            )}

            {/* CTA link */}
            {meta?.cta && (
              <a
                href={meta.cta.href}
                className="mt-10 inline-block text-white/40 hover:text-white transition-colors text-lg"
              >
                {meta.cta.text} →
              </a>
            )}
          </div>
        </div>
      </div>

      {/* Bottom navigation */}
      <div className="absolute bottom-0 left-0 right-0 h-14 flex items-center justify-between px-8 md:px-16 bg-gradient-to-t from-[#0a0a0a] via-[#0a0a0a] to-transparent z-10">
        <button
          onClick={prev}
          disabled={current === 0}
          className="hover:text-white disabled:opacity-0 text-white/50 transition-colors px-4 py-2"
        >
          ←
        </button>

        <div className="flex items-center gap-1.5">
          {slides.map((_, i) => (
            <button
              key={i}
              onClick={() => goTo(i)}
              className={`w-2 h-2 rounded-full transition-colors ${
                i === current ? 'bg-white/80' : 'bg-white/25 hover:bg-white/50'
              }`}
            />
          ))}
        </div>

        <button
          onClick={next}
          disabled={current === slides.length - 1}
          className="hover:text-white disabled:opacity-0 text-white/50 transition-colors px-4 py-2"
        >
          →
        </button>
      </div>
    </div>
  );
}
