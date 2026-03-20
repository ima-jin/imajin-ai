'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ListingForm, ListingFormData } from '../../components/ListingForm';

export default function NewListingPage() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (data: ListingFormData) => {
    setIsLoading(true);
    setError('');

    try {
      const body: Record<string, unknown> = {
        title: data.title,
        description: data.description || undefined,
        price: data.price,
        currency: data.currency,
        category: data.category || undefined,
        images: [],
        sellerTier: data.sellerTier,
      };

      if (data.quantity !== null) {
        body.quantity = data.quantity;
      }

      if (data.sellerTier === 'public_offplatform') {
        const ci: Record<string, string> = {};
        if (data.contactInfo.phone) ci.phone = data.contactInfo.phone;
        if (data.contactInfo.email) ci.email = data.contactInfo.email;
        if (data.contactInfo.whatsapp) ci.whatsapp = data.contactInfo.whatsapp;
        body.contactInfo = ci;
      }

      const res = await fetch('/api/listings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body),
      });

      if (res.status === 401) {
        setError('You must be signed in to create a listing. Sign in at the auth service and try again.');
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || 'Failed to create listing. Please try again.');
        return;
      }

      const listing = await res.json();
      router.push(`/listings/${listing.id}`);
    } catch {
      setError('Network error. Please check your connection and try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100">
      <div className="container mx-auto px-4 py-8 max-w-2xl">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-blue-400 transition mb-6"
        >
          ← Back to listings
        </Link>

        <h1 className="text-2xl font-bold mb-2">Create a Listing</h1>
        <p className="text-gray-400 mb-8">List your item for sale on the Imajin network.</p>

        <ListingForm
          onSubmit={handleSubmit}
          submitLabel="Create Listing"
          isLoading={isLoading}
          error={error}
        />
      </div>
    </div>
  );
}
