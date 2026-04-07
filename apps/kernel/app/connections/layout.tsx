'use client';

import { IdentityProvider } from './context/IdentityContext';
import { ToastProvider } from '@imajin/ui';

export default function ConnectionsLayout({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <IdentityProvider>
        <main className="container mx-auto px-4 py-8">
          {children}
        </main>
      </IdentityProvider>
    </ToastProvider>
  );
}
