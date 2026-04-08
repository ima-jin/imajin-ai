'use client';

import { useEffect, useState } from 'react';
import { useUnreadCount } from '@/src/contexts/UnreadCountContext';

export function UnreadTitleManager() {
  const { total } = useUnreadCount();
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const handleVisibilityChange = () => setIsVisible(!document.hidden);
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    const prefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX?.includes('dev-')
      ? ' [DEV]'
      : '';

    if (!isVisible && total > 0) {
      document.title = `(${total}) Imajin Chat${prefix}`;
    } else {
      document.title = `Imajin Chat${prefix}`;
    }
  }, [total, isVisible]);

  return null;
}
