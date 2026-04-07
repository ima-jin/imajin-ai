'use client';

import { Suspense, useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { resolveMediaRef } from '@imajin/media';
import { buildPublicUrl, apiFetch } from '@imajin/config';

const CHAT_URL = buildPublicUrl('chat', process.env.NEXT_PUBLIC_SERVICE_PREFIX, process.env.NEXT_PUBLIC_DOMAIN);

interface Listing {
  id: string;
  title: string;
  images: string[];
  price: number;
  currency: string;
  sellerDid?: string;
}

function CheckoutSuccessContent() {
  const searchParams = useSearchParams();
  const listingId = searchParams.get('listing');

  const [listing, setListing] = useState<Listing | null>(null);

  useEffect(() => {
    if (!listingId) return;
    apiFetch(`/api/listings/${listingId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setListing(data))
      .catch(() => null);
  }, [listingId]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center px-4">
      <div className="bg-white dark:bg-gray-900 rounded-2xl border border-gray-200 dark:border-gray-800 p-8 max-w-md w-full text-center shadow-sm">

        <div className="text-6xl mb-4">🎉</div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
          Purchase Complete!
        </h1>

        {listing ? (
          <>
            {listing.images?.[0] && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={resolveMediaRef(listing.images[0], 'card')}
                alt={listing.title}
                className="w-24 h-24 object-cover rounded-xl mx-auto my-4"
              />
            )}
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              You&apos;ve purchased{' '}
              <span className="font-semibold text-gray-900 dark:text-gray-100">
                {listing.title}
              </span>
            </p>
          </>
        ) : (
          <p className="text-gray-600 dark:text-gray-400 mb-6">
            Your purchase was successful.
          </p>
        )}

        <div className="flex flex-col gap-3">
          {listing?.sellerDid && listingId && (
            <Link
              href={`${CHAT_URL}/start?did=${listing.sellerDid}`}
              className="px-6 py-3 bg-orange-500 text-white rounded-xl font-semibold hover:bg-orange-600 transition"
            >
              Message Seller
            </Link>
          )}
          {listingId && (
            <Link
              href={`/listings/${listingId}`}
              className="px-6 py-3 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-gray-700 transition"
            >
              View Listing
            </Link>
          )}
          <Link
            href="/"
            className="px-6 py-3 bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 rounded-xl font-semibold hover:bg-gray-200 dark:hover:bg-gray-700 transition"
          >
            Back to Market
          </Link>
        </div>

      </div>
    </div>
  );
}

export default function CheckoutSuccessPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-gray-950" />}>
      <CheckoutSuccessContent />
    </Suspense>
  );
}
