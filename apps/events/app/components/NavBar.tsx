'use client';

import { NavBar as BaseNavBar } from '@imajin/ui';
import type { ServiceUrls } from '@imajin/ui';

const PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

const SERVICE_URL_KEYS: (keyof ServiceUrls)[] = ['www', 'events', 'auth', 'connections', 'chat', 'profile', 'pay', 'registry'];
const serviceUrls: ServiceUrls = {};
for (const key of SERVICE_URL_KEYS) {
  const envVal = process.env[`NEXT_PUBLIC_${key.toUpperCase()}_URL`];
  if (envVal) serviceUrls[key] = envVal;
}

interface NavBarProps {
  currentService?: string;
}

export function NavBar({ currentService = 'Events' }: NavBarProps) {
  return (
    <BaseNavBar
      currentService={currentService}
      servicePrefix={PREFIX}
      domain={DOMAIN}
      serviceUrls={Object.keys(serviceUrls).length > 0 ? serviceUrls : undefined}
    />
  );
}
