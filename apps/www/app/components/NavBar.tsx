'use client';

import { NavBar as BaseNavBar } from '@imajin/ui';

const PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

interface NavBarProps {
  currentService?: string;
}

export function NavBar({ currentService = 'Home' }: NavBarProps) {
  return (
    <BaseNavBar
      currentService={currentService}
      servicePrefix={PREFIX}
      domain={DOMAIN}
    />
  );
}
