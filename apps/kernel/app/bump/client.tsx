'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import BumpConnect from '../connections/bump/BumpConnect';

export default function BumpPageClient() {
  const router = useRouter();
  const [started, setStarted] = useState(false);

  if (!started) {
    return (
      <div className="min-h-screen bg-[#0a0a0a] flex items-center justify-center p-4">
        <button
          onClick={() => setStarted(true)}
          className="flex flex-col items-center gap-4 group"
        >
          <span className="text-[3.5rem] sm:text-[7rem] font-black text-primary tracking-tight">Bump?</span>
          <span className="text-[7rem] sm:text-[14rem] leading-none select-none group-active:scale-110 transition-transform">🤜🤛</span>
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] flex flex-col items-center justify-center p-4">
      <h1 className="text-[5rem] sm:text-[7rem] font-black text-primary tracking-tight mb-4 font-mono">Bump!</h1>
      <BumpConnect onClose={() => setStarted(false)} />
    </div>
  );
}
