'use client';

import { useState, useEffect } from 'react';

interface MarketItemsProps {
  did: string;
  handle?: string;
  servicePrefix: string;
  domain: string;
}

interface Listing {
  id: string;
  title: string;
  price: number;
  currency: string;
  images?: string[];
}

const ZERO_DECIMAL = new Set(['JPY','KRW','VND','CLP','BIF','DJF','GNF','ISK','KMF','PYG','RWF','UGX','VUV','XAF','XOF','XPF']);

function formatPrice(amount: number, currency: string) {
  const value = ZERO_DECIMAL.has(currency) ? amount : amount / 100;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value);
}

export function MarketItems({ did, handle, servicePrefix, domain }: MarketItemsProps) {
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [loading, setLoading] = useState(true);

  const marketBase = process.env.NEXT_PUBLIC_MARKET_URL || `${servicePrefix}market.${domain}`;

  useEffect(() => {
    fetch(`${marketBase}/api/listings?seller_did=${encodeURIComponent(did)}&status=active&limit=8`)
      .then((r) => r.ok ? r.json() : Promise.reject())
      .then((data) => setListings(Array.isArray(data) ? data : (data.listings || [])))
      .catch(() => setListings([]))
      .finally(() => setLoading(false));
  }, [did, marketBase]);

  if (loading) {
    return (
      <div className="mt-6">
        <div className="h-5 w-24 bg-gray-800 rounded animate-pulse mb-3" />
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden animate-pulse">
              <div className="aspect-square bg-gray-800" />
              <div className="p-2 space-y-1">
                <div className="h-3 bg-gray-800 rounded w-3/4" />
                <div className="h-3 bg-gray-800 rounded w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!listings || listings.length === 0) return null;

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-300">
          🏪 Market
          <span className="ml-1.5 text-gray-500 font-normal">({listings.length})</span>
        </h2>
        <a
          href={handle ? `${marketBase}/seller/${encodeURIComponent(handle)}` : `${marketBase}/listings?seller_did=${encodeURIComponent(did)}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[#F59E0B] hover:underline"
        >
          View all →
        </a>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {listings.map((listing) => (
          <a
            key={listing.id}
            href={`${marketBase}/listings/${listing.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden hover:border-gray-700 transition group"
          >
            <div className="aspect-square bg-gray-800 flex items-center justify-center overflow-hidden">
              {listing.images && listing.images.length > 0 ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={listing.images[0]}
                  alt={listing.title}
                  className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-200"
                />
              ) : (
                <span className="text-2xl">🏪</span>
              )}
            </div>
            <div className="p-2">
              <p className="text-xs text-white font-medium truncate">{listing.title}</p>
              <p className="text-xs text-[#F59E0B] mt-0.5">{formatPrice(listing.price, listing.currency)}</p>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}
