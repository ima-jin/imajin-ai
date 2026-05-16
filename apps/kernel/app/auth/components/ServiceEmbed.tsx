'use client';

interface Props {
  service: string;
  did: string;
}

const SERVICE_URLS: Record<string, string> = {
  events: process.env.NEXT_PUBLIC_EVENTS_URL ?? '',
  market: process.env.NEXT_PUBLIC_MARKET_URL ?? '',
  coffee: process.env.NEXT_PUBLIC_COFFEE_URL ?? '',
  dykil: process.env.NEXT_PUBLIC_DYKIL_URL ?? '',
  learn: process.env.NEXT_PUBLIC_LEARN_URL ?? '',
  links: process.env.NEXT_PUBLIC_LINKS_URL ?? '',
  pay: '', // kernel service, same origin
  media: '', // kernel service, same origin
};

export default function ServiceEmbed({ service, did }: Props) {
  const baseUrl = SERVICE_URLS[service] ?? '';

  // Kernel services (pay, media) use their own path, not /dashboard
  const KERNEL_PATHS: Record<string, string> = {
    pay: '/pay',
    media: '/media',
  };

  const path = KERNEL_PATHS[service] || '/dashboard';
  const src = baseUrl
    ? `${baseUrl}${path}?embed=hub&did=${encodeURIComponent(did)}`
    : `${path}?embed=hub&did=${encodeURIComponent(did)}`;

  return (
    <iframe
      src={src}
      className="w-full min-h-[600px] border-0 rounded-lg"
      allow="clipboard-write"
      title={`${service} dashboard`}
    />
  );
}
