'use client';

import { ToastProvider } from '@imajin/ui';

export function Providers({ children }: { children: React.ReactNode }) {
  return <ToastProvider>{children}</ToastProvider>;
}
