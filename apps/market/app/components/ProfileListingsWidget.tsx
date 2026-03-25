'use client';

import { useEffect, useState } from 'react';
import { resolveMediaRef } from '@imajin/media';

interface ProfileListing {
  id: string;
  title: string;
  price: number;
  currency: string;
  images: unknown;
  category: string | null;
  sellerTier: string;
  createdAt: string;
}

interface ProfileListingsWidgetProps {
  sellerDid: string;
  marketServiceUrl: string;
}

function formatPrice(price: number, currency: string): string {
  const ZERO_DECIMAL = new Set(['JPY', 'KRW', 'VND', 'BIF', 'CLP', 'GNF', 'ISK', 'MGA', 'PYG', 'RWF', 'UGX', 'XAF', 'XOF', 'XPF']);
  const amount = ZERO_DECIMAL.has(currency.toUpperCase()) ? price : price / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}

function MiniCard({
  listing,
  marketServiceUrl,
}: {
  listing: ProfileListing;
  marketServiceUrl: string;
}) {
  const images = Array.isArray(listing.images) ? listing.images : [];
  const primaryRef = images.find(
    (img): img is string => typeof img === 'string' && img.length > 0
  );
  const primaryImage = primaryRef ? resolveMediaRef(primaryRef, 'card') : undefined;

  return (
    <a
      href={`${marketServiceUrl}/listings/${listing.id}`}
      target="_blank"
      rel="noopener noreferrer"
      className="group bg-gray-900 border border-gray-800 rounded-xl overflow-hidden hover:border-gray-600 hover:shadow-lg hover:shadow-black/40 transition-all duration-200 hover:scale-[1.01] flex flex-col"
    >
      <div className="aspect-video bg-gradient-to-br from-gray-800 to-gray-700 relative overflow-hidden">
        {primaryImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={primaryImage} alt={listing.title} className="w-full h-full object-cover" />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center text-gray-600">
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
        )}
      </div>
      <div className="p-3 flex flex-col flex-1">
        <h4 className="text-white text-sm font-semibold line-clamp-2 mb-1 group-hover:text-amber-400 transition-colors">
          {listing.title}
        </h4>
        <span className="text-amber-400 font-bold text-sm mt-auto">
          {formatPrice(listing.price, listing.currency)}
        </span>
        {listing.category && (
          <span className="mt-1 px-2 py-0.5 text-xs bg-gray-800 text-gray-400 rounded-full border border-gray-700 self-start">
            {listing.category}
          </span>
        )}
      </div>
    </a>
  );
}

export default function ProfileListingsWidget({
  sellerDid,
  marketServiceUrl,
}: ProfileListingsWidgetProps) {
  const [listings, setListings] = useState<ProfileListing[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const url = `${marketServiceUrl}/api/seller/${encodeURIComponent(sellerDid)}/profile-listings`;
    fetch(url)
      .then((res) => res.json())
      .then((data) => {
        setEnabled(data.enabled ?? false);
        setListings(data.listings ?? []);
      })
      .catch(() => {
        // Silently fail — widget just doesn't render
      })
      .finally(() => setLoaded(true));
  }, [sellerDid, marketServiceUrl]);

  if (!loaded || !enabled || listings.length === 0) return null;

  return (
    <section className="mt-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-base font-semibold text-white">
          For Sale{' '}
          <span className="text-gray-400 font-normal text-sm">({listings.length})</span>
        </h3>
        <a
          href={`${marketServiceUrl}/dashboard`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-orange-400 hover:text-orange-300 transition"
        >
          View all →
        </a>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {listings.map((listing) => (
          <MiniCard
            key={listing.id}
            listing={listing}
            marketServiceUrl={marketServiceUrl}
          />
        ))}
      </div>
    </section>
  );
}
