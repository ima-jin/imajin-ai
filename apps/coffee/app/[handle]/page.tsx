import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { db, coffeePages } from '@/db';
import { buildPublicUrl } from '@imajin/config';
import TipForm from './tip-form';

interface PageProps {
  params: { handle: string };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const page = await db.query.coffeePages.findFirst({
    where: (pages, { eq }) => eq(pages.handle, params.handle),
  });

  if (!page || !page.isPublic) {
    return { title: 'Coffee | Imajin' };
  }

  const title = `${page.title} | Coffee | Imajin`;
  const description = page.bio || 'Support this creator on the Imajin network';
  const url = `${buildPublicUrl('coffee')}/${page.handle}`;
  const avatarIsImage = page.avatar && (page.avatar.startsWith('http') || page.avatar.startsWith('/'));
  const ogImage = avatarIsImage
    ? (page.avatar!.startsWith('http') ? page.avatar! : `${buildPublicUrl('coffee')}${page.avatar}`)
    : null;

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url,
      siteName: 'Imajin',
      type: 'profile',
      ...(ogImage ? { images: [{ url: ogImage }] } : {}),
    },
    twitter: {
      card: ogImage ? 'summary_large_image' : 'summary',
      title,
      description,
      ...(ogImage ? { images: [ogImage] } : {}),
    },
    other: {
      ...(ogImage && { image: ogImage }),
    },
  };
}

export default async function CoffeePage({ params }: PageProps) {
  // Skip static file requests that leak through
  if (params.handle.includes('.') || params.handle === 'favicon') {
    notFound();
  }

  const page = await db.query.coffeePages.findFirst({
    where: (pages, { eq }) => eq(pages.handle, params.handle),
  });

  if (!page || !page.isPublic) {
    notFound();
  }

  // Check if the page owner has Stripe Connect enabled
  let sellerConnected = true;
  try {
    const PAY_SERVICE_URL = process.env.PAY_SERVICE_URL || 'http://localhost:3004';
    const checkRes = await fetch(
      `${PAY_SERVICE_URL}/api/connect/check?did=${encodeURIComponent(page.did)}`,
      { cache: 'no-store' }
    );
    if (checkRes.ok) {
      const checkData = await checkRes.json();
      sellerConnected = checkData.chargesEnabled ?? false;
    }
  } catch {
    // Default to connected so we don't block tips on error
  }

  const theme = (page.theme || {}) as Record<string, string>;
  const bgColor = theme.backgroundColor || '#fffbeb';
  const primaryColor = theme.primaryColor || '#f59e0b';

  const avatarIsImage = page.avatar && (page.avatar.startsWith('http') || page.avatar.includes('/'));

  return (
    <div
      className="min-h-screen"
      style={{ backgroundColor: bgColor }}
    >
      <div
        className="max-w-lg mx-auto px-4 py-12 text-center"
        style={{ '--primary-color': primaryColor } as React.CSSProperties}
      >
        {/* Avatar */}
        <div className="mb-4">
          {avatarIsImage ? (
            <img
              src={page.avatar!}
              alt={page.title}
              className="w-24 h-24 rounded-full mx-auto object-cover"
            />
          ) : (
            <div
              className="w-24 h-24 rounded-full mx-auto flex items-center justify-center text-4xl"
              style={{ backgroundColor: primaryColor + '20' }}
            >
              {page.avatar || '☕'}
            </div>
          )}
        </div>

        {/* Title */}
        <h1 className="text-2xl font-bold mb-2">{page.title}</h1>

        {/* Bio */}
        {page.bio && (
          <p className="text-muted mb-6">{page.bio}</p>
        )}

        {/* A thought */}
        <div className="mb-6 bg-imajin-orange/10 dark:bg-imajin-orange/10 border border-imajin-orange/20 dark:border-imajin-orange/20 p-6 text-left">
          <h2 className="text-lg font-bold mb-3 text-orange-800 dark:text-imajin-orange">A thought on where your money goes</h2>
          <div className="text-orange-900 dark:text-orange-100 space-y-3 text-sm">
            <p>
              You probably spend $20/month on subscriptions you barely touch — feeding platforms
              that turn your attention into their product.
            </p>
            <p>
              What if that money went to open source projects building the alternative? Infrastructure
              owned by people, not shareholders. Tools that undo the mess instead of profiting from it.
            </p>
            <p className="font-semibold">This is that.</p>
          </div>
        </div>

        {/* Tip Form */}
        <TipForm
          page={{
            handle: page.handle,
            presets: page.presets ?? [300, 500, 1000],
            fundDirections: (page.fundDirections as any) ?? undefined,
            allowCustomAmount: page.allowCustomAmount ?? true,
            allowMessages: page.allowMessages ?? true,
            paymentMethods: (page.paymentMethods as any) ?? {},
          }}
          primaryColor={primaryColor}
          sellerConnected={sellerConnected}
        />

        {/* Footer */}
        <p className="text-center text-xs text-secondary mt-4">
          Powered by <a href="https://imajin.ai" className="hover:underline">Imajin</a>
          {' · '}
          No platform fees
        </p>
      </div>
    </div>
  );
}
