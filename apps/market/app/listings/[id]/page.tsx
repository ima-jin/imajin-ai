'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import PriceDisplay from '../../components/PriceDisplay';

interface ContactInfo {
  phone?: string;
  email?: string;
  whatsapp?: string;
}

interface Listing {
  id: string;
  title: string;
  description: string | null;
  price: number;
  currency: string;
  category: string | null;
  images: string[];
  sellerDid: string;
  sellerTier: string;
  contactInfo: ContactInfo | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function truncateDid(did: string): string {
  if (did.length <= 24) return did;
  return `${did.slice(0, 12)}…${did.slice(-8)}`;
}

export default function ListingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeImage, setActiveImage] = useState(0);

  const servicePrefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
  const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
  const profileUrl = `${servicePrefix}profile.${domain}`;

  useEffect(() => {
    async function fetchListing() {
      try {
        const res = await fetch(`/api/listings/${id}`);
        if (res.status === 404) {
          setError('Listing not found.');
          return;
        }
        if (!res.ok) throw new Error('Failed to load listing');
        const data: Listing = await res.json();
        setListing(data);
      } catch {
        setError('Could not load this listing. Please try again.');
      } finally {
        setLoading(false);
      }
    }
    fetchListing();
  }, [id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950">
        <div className="container mx-auto px-4 py-8 max-w-4xl animate-pulse">
          <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-24 mb-6" />
          <div className="grid md:grid-cols-2 gap-8">
            <div className="aspect-square bg-gray-200 dark:bg-gray-800 rounded-xl" />
            <div className="space-y-4">
              <div className="h-8 bg-gray-200 dark:bg-gray-800 rounded w-3/4" />
              <div className="h-10 bg-gray-200 dark:bg-gray-800 rounded w-1/3" />
              <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-full" />
              <div className="h-4 bg-gray-200 dark:bg-gray-800 rounded w-5/6" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error || !listing) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <div className="text-center px-4">
          <div className="text-5xl mb-4">🏪</div>
          <p className="text-lg font-medium mb-2 text-gray-900 dark:text-gray-100">{error || 'Listing not found'}</p>
          <Link href="/" className="text-orange-500 hover:text-orange-600 transition text-sm">
            ← Back to listings
          </Link>
        </div>
      </div>
    );
  }

  const images = listing.images || [];
  const hasImages = images.length > 0;
  const tierLabel = listing.sellerTier === 'public_onplatform' ? 'Protected' : 'Direct';
  const tierColor =
    listing.sellerTier === 'public_onplatform'
      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
      : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <div className="container mx-auto px-4 py-8 max-w-4xl">

        {/* Back link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-orange-500 transition mb-6">
          ← Back to listings
        </Link>

        <div className="grid md:grid-cols-2 gap-8">

          {/* Image gallery */}
          <div>
            <div className="aspect-square bg-gray-100 dark:bg-gray-800 rounded-xl overflow-hidden flex items-center justify-center mb-3">
              {hasImages ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={images[activeImage]}
                  alt={listing.title}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-7xl">🏪</span>
              )}
            </div>

            {hasImages && images.length > 1 && (
              <div className="flex gap-2 flex-wrap">
                {images.map((src, i) => (
                  <button
                    key={i}
                    onClick={() => setActiveImage(i)}
                    className={`w-16 h-16 rounded-lg overflow-hidden border-2 transition ${
                      i === activeImage ? 'border-orange-500' : 'border-transparent opacity-60 hover:opacity-100'
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={src} alt={`Image ${i + 1}`} className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Details */}
          <div className="flex flex-col gap-4">

            {/* Title */}
            <h1 className="text-2xl font-bold leading-tight">{listing.title}</h1>

            {/* Price */}
            <PriceDisplay
              amount={listing.price}
              currency={listing.currency}
              className="text-3xl font-bold text-orange-500"
            />

            {/* Badges */}
            <div className="flex flex-wrap gap-2">
              {listing.category && (
                <span className="text-sm px-3 py-1 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400">
                  {listing.category}
                </span>
              )}
              <span className={`text-sm px-3 py-1 rounded-full font-medium ${tierColor}`}>
                {tierLabel}
              </span>
            </div>

            {/* Description */}
            {listing.description && (
              <p className="text-gray-600 dark:text-gray-400 leading-relaxed whitespace-pre-wrap">
                {listing.description}
              </p>
            )}

            {/* Seller section */}
            <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4">
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-1">Listed by</p>
              <a
                href={`${profileUrl}/${encodeURIComponent(listing.sellerDid)}`}
                className="text-sm font-mono text-orange-500 hover:text-orange-600 transition break-all"
              >
                {truncateDid(listing.sellerDid)}
              </a>
            </div>

            {/* Tier 1: Direct contact info */}
            {listing.sellerTier === 'public_offplatform' && listing.contactInfo && (
              <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
                <p className="text-sm font-semibold">Contact Seller</p>
                {listing.contactInfo.phone && (
                  <a
                    href={`tel:${listing.contactInfo.phone}`}
                    className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 hover:text-orange-500 transition"
                  >
                    <span>📞</span>
                    <span>{listing.contactInfo.phone}</span>
                  </a>
                )}
                {listing.contactInfo.email && (
                  <a
                    href={`mailto:${listing.contactInfo.email}`}
                    className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 hover:text-orange-500 transition"
                  >
                    <span>✉️</span>
                    <span>{listing.contactInfo.email}</span>
                  </a>
                )}
                {listing.contactInfo.whatsapp && (
                  <a
                    href={`https://wa.me/${listing.contactInfo.whatsapp.replace(/\D/g, '')}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 hover:text-orange-500 transition"
                  >
                    <span>💬</span>
                    <span>WhatsApp</span>
                  </a>
                )}
              </div>
            )}

            {/* Tier 2: Buy Now */}
            {listing.sellerTier === 'public_onplatform' && (
              <a
                href={`/checkout/${listing.id}`}
                className="inline-block text-center px-6 py-3 bg-orange-500 text-white rounded-xl font-semibold hover:bg-orange-600 transition hover:shadow-lg"
              >
                Buy Now
              </a>
            )}

            {/* Metadata */}
            <div className="text-xs text-gray-400 dark:text-gray-500 space-y-1 pt-2 border-t border-gray-100 dark:border-gray-800">
              <p>Posted {formatRelativeTime(listing.createdAt)}</p>
              <p className="font-mono">{listing.id}</p>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
