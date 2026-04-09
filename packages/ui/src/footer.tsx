'use client';

import { useEffect, useState } from 'react';
import { BuildInfo } from './BuildInfo';

function getServiceFromPathname(pathname: string): string {
  const segment = pathname.split('/').filter(Boolean)[0];
  if (!segment) return 'landing';
  return segment;
}

export function ImajinFooter({ className }: { className?: string }) {
  const [subscribeHref, setSubscribeHref] = useState('/subscribe');

  useEffect(() => {
    const service = getServiceFromPathname(window.location.pathname);
    setSubscribeHref(`/subscribe?from=${service}`);
  }, []);

  return (
    <div className={`flex flex-col items-center gap-2 ${className || ""}`}>
      <p className="text-center text-sm text-gray-500">
        Part of the{" "}
        <a href="https://imajin.ai" className="text-orange-500 hover:underline">Imajin</a>
        {" "}sovereign network{" · "}
        <a href="https://app.dfos.com/j/c3rff6e96e4ca9hncc43en" className="hover:underline">Community</a>
        {" · "}
        <a href="https://github.com/ima-jin/imajin-ai" className="hover:underline">GitHub</a>
        {" · "}
        <a href="/privacy" className="hover:underline">Privacy</a>
        {" · "}
        <a href={subscribeHref} className="hover:underline">Subscribe</a>
      </p>
      <BuildInfo />
    </div>
  );
}
