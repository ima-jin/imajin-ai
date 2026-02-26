'use client';

import { useRouter } from 'next/navigation';
import { useIdentity } from '../context/IdentityContext';
import { NavBar as BaseNavBar } from '@imajin/ui';

const PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

interface NavBarProps {
  currentService?: string;
}

export function NavBar({ currentService = 'Profile' }: NavBarProps) {
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
