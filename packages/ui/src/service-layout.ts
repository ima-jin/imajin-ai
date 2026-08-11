import { APP_DISPLAY_NAME } from '@imajin/config';

export const defaultViewport = {
  width: 'device-width',
  initialScale: 1,
} as const;

export function buildServiceMetadata(serviceName: string, description: string) {
  const title = `${serviceName} | ${APP_DISPLAY_NAME}`;
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: APP_DISPLAY_NAME,
      type: 'website',
    },
    twitter: {
      card: 'summary',
      title,
      description,
    },
  };
}

export function getServiceRuntimeEnv() {
  return {
    servicePrefix: process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://',
    domain: process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai',
  };
}
