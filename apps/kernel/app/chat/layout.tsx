import { IdentityProvider } from '@/src/contexts/IdentityContext';
import { UnreadTitleManager } from './components/UnreadTitleManager';
import { ToastProvider } from '@imajin/ui';

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ToastProvider>
      <IdentityProvider>
        <UnreadTitleManager />
        <main className="container mx-auto px-4 py-4">
          {children}
        </main>
      </IdentityProvider>
    </ToastProvider>
  );
}
