'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Props {
  href: string;
  seconds: number;
}

export function AutoRedirect({ href, seconds }: Props) {
  const router = useRouter();
  const [countdown, setCountdown] = useState(seconds);

  useEffect(() => {
    const timer = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          // Use window.location for hash navigation so the browser scrolls
          // to the anchor naturally (router.push doesn't scroll to hash)
          window.location.href = href;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [href, router]);

  return (
    <p className="text-sm text-red-400 mt-2">
      Redirecting in {countdown}…
    </p>
  );
}
