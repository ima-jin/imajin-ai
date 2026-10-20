import { notFound } from 'next/navigation';
import { CloudflarePreview } from './cloudflare-preview';

export default function CloudflarePreviewPage() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <CloudflarePreview />;
}
