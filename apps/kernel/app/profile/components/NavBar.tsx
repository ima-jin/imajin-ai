'use client';

import { NavBar as BaseNavBar } from '@imajin/ui';
import type { ServiceUrls } from '@imajin/ui';
import { useIdentity } from '../context/IdentityContext';
import { useRouter } from 'next/navigation';

const PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

// Must use literal process.env.NEXT_PUBLIC_* for Next.js to inline at build time
const serviceUrls: ServiceUrls = {
  ...(process.env.NEXT_PUBLIC_WWW_URL && { www: process.env.NEXT_PUBLIC_WWW_URL }),
  ...(process.env.NEXT_PUBLIC_AUTH_URL && { auth: process.env.NEXT_PUBLIC_AUTH_URL }),
  ...(process.env.NEXT_PUBLIC_EVENTS_URL && { events: process.env.NEXT_PUBLIC_EVENTS_URL }),
  ...(process.env.NEXT_PUBLIC_PROFILE_URL && { profile: process.env.NEXT_PUBLIC_PROFILE_URL }),
  ...(process.env.NEXT_PUBLIC_PAY_URL && { pay: process.env.NEXT_PUBLIC_PAY_URL }),
  ...(process.env.NEXT_PUBLIC_CONNECTIONS_URL && { connections: process.env.NEXT_PUBLIC_CONNECTIONS_URL }),
  ...(process.env.NEXT_PUBLIC_CHAT_URL && { chat: process.env.NEXT_PUBLIC_CHAT_URL }),
  ...(process.env.NEXT_PUBLIC_REGISTRY_URL && { registry: process.env.NEXT_PUBLIC_REGISTRY_URL }),
};
const hasOverrides = Object.keys(serviceUrls).length > 0;

export function NavBar({ currentService = 'Profile' }: { currentService?: string }) {
  const router = useRouter();
  const { isLoggedIn, handle, did, logout } = useIdentity();

  return (
    <BaseNavBar
      currentService={currentService}
      servicePrefix={PREFIX}
      domain={DOMAIN}
      serviceUrls={hasOverrides ? serviceUrls : undefined}
      identity={{
        isLoggedIn,
        handle,
        did,
        onLogout: () => { logout(); router.push('/'); },
        onViewProfile: () => router.push(`/${handle || did}`),
        onEditProfile: () => router.push('/edit'),
        onLogin: () => router.push('/login'),
        onRegister: () => router.push('/register'),
      }}
    />
  );
}
