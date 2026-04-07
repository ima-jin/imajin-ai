'use client';

import { ToastProvider } from '@imajin/ui';
import { UnreadCountProvider } from '@/src/contexts/UnreadCountContext';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <UnreadCountProvider>
      <ToastProvider>{children}</ToastProvider>
    </UnreadCountProvider>
  );
}
