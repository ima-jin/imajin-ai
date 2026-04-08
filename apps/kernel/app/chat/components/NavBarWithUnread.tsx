'use client';

import { NavBar } from '@imajin/ui';
import { useUnreadCount } from '@/src/contexts/UnreadCountContext';

export function NavBarWithUnread() {
  const { total } = useUnreadCount();

  return (
    <NavBar
      currentService="Chat"
      unreadMessages={total}
      servicePrefix={process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://'}
      domain={process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai'}
    />
  );
}
