'use client';

import { NavBar as BaseNavBar } from '@imajin/ui';
import type { ServiceUrls } from '@imajin/ui';

const PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';

const serviceUrls: ServiceUrls = {
  ...(process.env.NEXT_PUBLIC_WWW_URL && { www: process.env.NEXT_PUBLIC_WWW_URL }),
  ...(process.env.NEXT_PUBLIC_AUTH_URL && { auth: process.env.NEXT_PUBLIC_AUTH_URL }),
  ...(process.env.NEXT_PUBLIC_PROFILE_URL && { profile: process.env.NEXT_PUBLIC_PROFILE_URL }),
  ...(process.env.NEXT_PUBLIC_CONNECTIONS_URL && { connections: process.env.NEXT_PUBLIC_CONNECTIONS_URL }),
  ...(process.env.NEXT_PUBLIC_CHAT_URL && { chat: process.env.NEXT_PUBLIC_CHAT_URL }),
  ...(process.env.NEXT_PUBLIC_REGISTRY_URL && { registry: process.env.NEXT_PUBLIC_REGISTRY_URL }),
  ...(process.env.NEXT_PUBLIC_NOTIFY_URL && { notify: process.env.NEXT_PUBLIC_NOTIFY_URL }),
};
const hasOverrides = Object.keys(serviceUrls).length > 0;

export function NavBar() {
  return (
    <BaseNavBar
      currentService="notify"
      servicePrefix={PREFIX}
      domain={DOMAIN}
      {...(hasOverrides ? { serviceUrls } : {})}
    />
  );
}
