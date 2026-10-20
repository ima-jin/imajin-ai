import { notFound } from 'next/navigation';

export function GET() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return new Response('FIXTURE ONLY — Service agreement\nImajin Studio and Alex agree to a two-week design engagement.\n', {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
