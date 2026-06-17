'use client';

import { SWRConfig } from 'swr';
import { ToastProvider, NotificationProvider } from '@imajin/ui';
import { UnreadCountProvider } from '@/src/contexts/UnreadCountContext';
import { fetcher } from '@/src/lib/swr/fetcher';
import { ClientErrorReporter } from '@/src/components/ClientErrorReporter';

export function Providers({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <SWRConfig value={{ fetcher, revalidateOnFocus: true, dedupingInterval: 5000, errorRetryCount: 2 }}>
      <UnreadCountProvider>
        <ToastProvider>
          <NotificationProvider>
            {children}
            <ClientErrorReporter />
          </NotificationProvider>
        </ToastProvider>
      </UnreadCountProvider>
    </SWRConfig>
  );
}
