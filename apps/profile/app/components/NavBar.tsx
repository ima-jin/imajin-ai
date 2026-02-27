'use client';

import { NavBar as BaseNavBar } from '@imajin/ui';
import { useIdentity } from '../context/IdentityContext';
import { useRouter } from 'next/navigation';

const PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

export function NavBar({ currentService = 'Profile' }: { currentService?: string }) {
  const router = useRouter();
  const { isLoggedIn, handle, did, logout } = useIdentity();

  return (
    <BaseNavBar
      currentService={currentService}
      servicePrefix={PREFIX}
      domain={DOMAIN}
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
