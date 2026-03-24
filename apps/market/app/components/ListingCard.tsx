'use client';

import Link from 'next/link';
import { resolveMediaRef } from '@imajin/media';
import PriceDisplay from './PriceDisplay';

interface Listing {
  id: string;
  title: string;
  price: number;
  currency: string;
  category: string | null;
  images: unknown;
  sellerTier: string;
  createdAt: Date;
}

function relativeTime(date: Date): string {
  const diff = Date.now() - new Date(date).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(date).toLocaleDateString();
}

function TierBadge({ tier }: { tier: string }) {
  if (tier === 'public_offplatform') {
    return (
      <span className="px-1.5 py-0.5 text-xs font-medium bg-amber-900/50 text-amber-400 border border-amber-700/50 rounded">
        Direct
      </span>
    );
  }
  if (tier === 'public_onplatform') {
    return (
      <span className="px-1.5 py-0.5 text-xs font-medium bg-green-900/50 text-green-400 border border-green-700/50 rounded">
        Protected
      </span>
    );
  }
  return null;
}

export default function ListingCard({ listing }: { listing: Listing }) {
  const images = Array.isArray(listing.images) ? listing.images : [];
  const primaryRef = images.find((img): img is string => typeof img === 'string' && img.length > 0);
  const primaryImage = primaryRef ? resolveMediaRef(primaryRef, 'card') : undefined;

  return (
    <Link
      href={`/listings/${listing.id}`}
      className="group bg-gray-900 border border-gray-800 rounded-xl overflow-hidden hover:border-gray-600 hover:shadow-lg hover:shadow-black/40 transition-all duration-200 hover:scale-[1.01] flex flex-col"
    >
      {/* Image */}
      <div className="aspect-video bg-gradient-to-br from-gray-800 to-gray-700 relative overflow-hidden">
        {primaryImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={primaryImage} alt={listing.title} className="w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-gray-600">
            <svg className="w-12 h-12" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1}
                d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
              />
            </svg>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="p-4 flex flex-col flex-1">
        <h3 className="text-white font-semibold line-clamp-2 mb-1 group-hover:text-amber-400 transition-colors">
          {listing.title}
        </h3>
        <PriceDisplay
          price={listing.price}
          currency={listing.currency}
          className="text-lg font-bold text-amber-400 mb-2"
        />
        <div className="flex items-center gap-2 flex-wrap mt-auto pt-2">
          {listing.category && (
            <span className="px-2 py-0.5 text-xs bg-gray-800 text-gray-400 rounded-full border border-gray-700">
              {listing.category}
            </span>
          )}
          <TierBadge tier={listing.sellerTier} />
          <span className="text-xs text-gray-500 ml-auto">{relativeTime(listing.createdAt)}</span>
        </div>
      </div>
    </Link>
  );
}
