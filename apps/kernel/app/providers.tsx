'use client';

import { SWRConfig } from 'swr';
import { ToastProvider } from '@imajin/ui';
import { UnreadCountProvider } from '@/src/contexts/UnreadCountContext';
import { fetcher } from '@/src/lib/swr/fetcher';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ fetcher, revalidateOnFocus: true, dedupingInterval: 5000, errorRetryCount: 2 }}>
      <UnreadCountProvider>
        <ToastProvider>{children}</ToastProvider>
      </UnreadCountProvider>
    </SWRConfig>
  );
}
