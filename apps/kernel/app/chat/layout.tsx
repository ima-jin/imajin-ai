import { IdentityProvider } from '@/src/contexts/IdentityContext';
import { UnreadTitleManager } from './components/UnreadTitleManager';
import { UnreadCountProvider } from '@/src/contexts/UnreadCountContext';
import { ToastProvider } from '@imajin/ui';

export default function ChatLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ToastProvider>
      <UnreadCountProvider>
        <IdentityProvider>
          <UnreadTitleManager />
          <main className="container mx-auto px-4 py-4">
            {children}
          </main>
        </IdentityProvider>
      </UnreadCountProvider>
    </ToastProvider>
  );
}
