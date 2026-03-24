import type { Metadata } from 'next';
import { db, listings } from '@/db';
import { eq } from 'drizzle-orm';
import { resolveMediaRef } from '@imajin/media';
import ListingDetail from './ListingDetail';

const DOMAIN = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
const SERVICE_PREFIX = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
const MARKET_URL = process.env.NEXT_PUBLIC_APP_URL || `${SERVICE_PREFIX}market.${DOMAIN}`;

interface Props {
  params: { id: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const [listing] = await db
    .select()
    .from(listings)
    .where(eq(listings.id, params.id))
    .limit(1);

  if (!listing) {
    return {
      title: 'Listing Not Found | Market | Imajin',
    };
  }

  const price = Number(listing.price);
  const currency = listing.currency || 'CAD';
  const priceStr = new Intl.NumberFormat('en-CA', {
    style: 'currency',
    currency,
    minimumFractionDigits: price % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(price / 100);

  const title = `${listing.title} — ${priceStr} | Market | Imajin`;
  const description = listing.description
    ? listing.description.replace(/\s+/g, ' ').trim().slice(0, 200)
    : `${listing.title} for ${priceStr} on Imajin Market`;

  const rawImages = ((listing.images as string[]) || []).filter(Boolean);
  const ogImage = rawImages.length > 0 ? resolveMediaRef(rawImages[0], 'og') : undefined;

  const url = `${MARKET_URL}/listings/${listing.id}`;

  return {
    title,
    description,
    openGraph: {
      title: listing.title,
      description,
      url,
      siteName: 'Imajin Market',
      type: 'website',
      ...(ogImage && { images: [{ url: ogImage, alt: listing.title }] }),
    },
    twitter: {
      card: ogImage ? 'summary_large_image' : 'summary',
      title: listing.title,
      description,
      ...(ogImage && { images: [ogImage] }),
    },
  };
}

export const dynamic = 'force-dynamic';

export default function ListingPage() {
  return <ListingDetail />;
}
