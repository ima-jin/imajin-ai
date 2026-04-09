'use client';

import { useState, useEffect } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { resolveMediaRef } from '@imajin/media';
import { apiFetch } from '@imajin/config';
import PriceDisplay from '../../components/PriceDisplay';
import { OnboardGate } from '@imajin/onboard';

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
  showContactInfo: boolean;
  contactInfo: ContactInfo | null;
  status: string;
  type: string;
  createdAt: string;
  updatedAt: string;
}

interface RelatedListing {
  id: string;
  title: string;
  price: number;
  currency: string;
  images: string[];
  sellerTier: string;
  status: string;
  type: string;
  createdAt: string;
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

function ContactSection({ contactInfo }: { contactInfo: ContactInfo }) {
  return (
    <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-4 space-y-3">
      <p className="text-sm font-semibold">Contact Seller</p>
      {contactInfo.phone && (
        <a
          href={`tel:${contactInfo.phone}`}
          className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 hover:text-orange-500 transition"
        >
          <span>📞</span>
          <span>{contactInfo.phone}</span>
        </a>
      )}
      {contactInfo.email && (
        <a
          href={`mailto:${contactInfo.email}`}
          className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 hover:text-orange-500 transition"
        >
          <span>✉️</span>
          <span>{contactInfo.email}</span>
        </a>
      )}
      {contactInfo.whatsapp && (
        <a
          href={`https://wa.me/${contactInfo.whatsapp.replace(/\D/g, '')}`}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 hover:text-orange-500 transition"
        >
          <span>💬</span>
          <span>WhatsApp</span>
        </a>
      )}
    </div>
  );
}

function OwnerStatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    active: 'bg-green-900/50 text-green-400 border-green-700/50',
    paused: 'bg-yellow-900/50 text-yellow-400 border-yellow-700/50',
    sold: 'bg-blue-900/50 text-blue-400 border-blue-700/50',
    rented: 'bg-purple-900/50 text-purple-400 border-purple-700/50',
    unavailable: 'bg-gray-700 text-gray-300 border-gray-600',
    removed: 'bg-gray-800 text-gray-400 border-gray-700',
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border ${styles[status] ?? 'bg-gray-800 text-gray-400 border-gray-700'}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

export default function ListingDetail() {
  const { id } = useParams<{ id: string }>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [gated, setGated] = useState(false);
  const [activeImage, setActiveImage] = useState(0);
  const [buyLoading, setBuyLoading] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
  const [sellerName, setSellerName] = useState<string | null>(null);
  const [sellerHandle, setSellerHandle] = useState<string | null>(null);
  const [sessionDid, setSessionDid] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [otherListings, setOtherListings] = useState<RelatedListing[]>([]);

  async function handleBuyNow() {
    if (!listing) return;
    setBuyLoading(true);
    setBuyError(null);
    try {
      const res = await apiFetch(`/api/listings/${listing.id}/purchase`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantity: 1 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setBuyError(data.error || 'Purchase failed. Please try again.');
        return;
      }
      window.location.href = data.url;
    } catch {
      setBuyError('Purchase failed. Please try again.');
    } finally {
      setBuyLoading(false);
    }
  }

  const servicePrefix = process.env.NEXT_PUBLIC_SERVICE_PREFIX || 'https://';
  const domain = process.env.NEXT_PUBLIC_DOMAIN || 'imajin.ai';
  const authUrl = `${servicePrefix}auth.${domain}`;

  useEffect(() => {
    async function fetchListing() {
      try {
        const res = await apiFetch(`/api/listings/${id}`);
        if (res.status === 404) {
          setError('Listing not found.');
          return;
        }
        if (res.status === 403) {
          const body = await res.json().catch(() => ({}));
          if (body.gated) {
            setGated(true);
          } else {
            setError('Access denied.');
          }
          return;
        }
        if (!res.ok) throw new Error('Failed to load listing');
        const data: Listing = await res.json();
        setListing(data);

        // Resolve seller name server-side via profile service
        try {
          const lookupRes = await apiFetch(
            `/api/resolve/${encodeURIComponent(data.sellerDid)}`
          );
          if (lookupRes.ok) {
            const identity = await lookupRes.json();
            if (identity?.handle) {
              setSellerHandle(identity.handle);
              setSellerName(`@${identity.handle}`);
            } else if (identity?.displayName) {
              setSellerName(identity.displayName);
            }
          }
        } catch {
          // Silently fall back to truncated DID
        }

        // Fetch current session DID to detect ownership
        try {
          const meRes = await apiFetch('/api/me', { credentials: 'include' });
          if (meRes.ok) {
            const me = await meRes.json();
            if (me?.did) setSessionDid(me.did);
          }
        } catch {
          // Not authenticated — no management strip
        }

        // Fetch other listings by this seller
        try {
          const relatedRes = await apiFetch(
            `/api/listings?seller_did=${encodeURIComponent(data.sellerDid)}&status=active&limit=4&exclude=${data.id}`
          );
          if (relatedRes.ok) {
            const relatedData = await relatedRes.json();
            setOtherListings(relatedData.listings ?? []);
          }
        } catch {
          // Best-effort
        }
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

  if (gated) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-950 flex items-center justify-center">
        <div className="text-center px-4 max-w-sm">
          <div className="text-5xl mb-4">🔒</div>
          <p className="text-lg font-medium mb-2 text-gray-900 dark:text-gray-100">
            Members only
          </p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
            This listing is only available to verified members.
          </p>
          <a
            href={`${authUrl}/login?next=${encodeURIComponent(typeof window !== 'undefined' ? window.location.href : '')}`}
            className="inline-block px-6 py-3 bg-orange-500 hover:bg-orange-600 text-white font-semibold rounded-xl transition"
          >
            Sign in to view
          </a>
          <div className="mt-4">
            <Link href="/" className="text-sm text-orange-500 hover:text-orange-600 transition">
              ← Back to listings
            </Link>
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

  const isOwner = !!sessionDid && sessionDid === listing.sellerDid;

  async function updateStatus(newStatus: string) {
    if (!listing) return;
    setActionLoading(newStatus);
    setActionError(null);
    try {
      const res = await apiFetch(`/api/listings/${listing.id}`, {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
      const data = await res.json();
      if (!res.ok) {
        setActionError(data.error || 'Action failed.');
        return;
      }
      setListing(data);
    } catch {
      setActionError('Action failed. Please try again.');
    } finally {
      setActionLoading(null);
    }
  }

  const images = (listing.images || []).filter(Boolean);
  const detailImages = images.map((ref: string) => resolveMediaRef(ref, 'detail'));
  const thumbImages = images.map((ref: string) => resolveMediaRef(ref, 'thumbnail'));
  const hasImages = detailImages.length > 0;

  const isSold = listing.status === 'sold';
  const isRented = listing.status === 'rented';
  const isUnavailable = listing.status === 'unavailable';
  const isInactive = isSold || isRented || isUnavailable;

  const isRental = listing.type === 'rental';
  const isOnplatform = listing.sellerTier === 'public_onplatform' || listing.sellerTier === 'trust_gated';

  const tierLabel =
    listing.sellerTier === 'public_onplatform'
      ? 'Protected'
      : listing.sellerTier === 'trust_gated'
      ? 'Trusted'
      : 'Direct';
  const tierColor =
    listing.sellerTier === 'public_onplatform'
      ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300'
      : listing.sellerTier === 'trust_gated'
      ? 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300'
      : 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';

  const showContactSection =
    listing.sellerTier === 'public_offplatform' ||
    (isOnplatform && listing.showContactInfo && listing.contactInfo);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <div className="container mx-auto px-4 py-8 max-w-4xl">

        {/* Back link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-sm text-gray-500 hover:text-orange-500 transition mb-6">
          ← Back to listings
        </Link>

        {/* Owner management strip */}
        {isOwner && (
          <div className="mb-6 bg-gray-900 border border-gray-700 rounded-xl p-4 flex flex-wrap items-center gap-3">
            <span className="text-xs text-gray-400 uppercase tracking-wide font-semibold">Your listing</span>
            <OwnerStatusBadge status={listing.status} />
            <div className="flex flex-wrap gap-2 ml-auto">
              <Link
                href={`/listings/${listing.id}/edit`}
                className="px-3 py-1.5 text-sm rounded-lg bg-gray-700 text-gray-200 hover:bg-gray-600 transition"
              >
                Edit
              </Link>
              {listing.status === 'active' && (
                <button
                  onClick={() => updateStatus('paused')}
                  disabled={!!actionLoading}
                  className="px-3 py-1.5 text-sm rounded-lg bg-yellow-900/50 text-yellow-400 hover:bg-yellow-900 border border-yellow-700/50 transition disabled:opacity-50"
                >
                  {actionLoading === 'paused' ? '…' : 'Pause'}
                </button>
              )}
              {listing.status === 'paused' && (
                <button
                  onClick={() => updateStatus('active')}
                  disabled={!!actionLoading}
                  className="px-3 py-1.5 text-sm rounded-lg bg-green-900/50 text-green-400 hover:bg-green-900 border border-green-700/50 transition disabled:opacity-50"
                >
                  {actionLoading === 'active' ? '…' : 'Resume'}
                </button>
              )}
              {listing.type === 'sale' && listing.status === 'active' && (
                <button
                  onClick={() => updateStatus('sold')}
                  disabled={!!actionLoading}
                  className="px-3 py-1.5 text-sm rounded-lg bg-blue-900/50 text-blue-400 hover:bg-blue-900 border border-blue-700/50 transition disabled:opacity-50"
                >
                  {actionLoading === 'sold' ? '…' : 'Mark Sold'}
                </button>
              )}
              {listing.type === 'rental' && listing.status === 'active' && (
                <button
                  onClick={() => updateStatus('rented')}
                  disabled={!!actionLoading}
                  className="px-3 py-1.5 text-sm rounded-lg bg-purple-900/50 text-purple-400 hover:bg-purple-900 border border-purple-700/50 transition disabled:opacity-50"
                >
                  {actionLoading === 'rented' ? '…' : 'Mark Rented'}
                </button>
              )}
              {(listing.status === 'active' || listing.status === 'paused') && (
                <button
                  onClick={() => updateStatus('unavailable')}
                  disabled={!!actionLoading}
                  className="px-3 py-1.5 text-sm rounded-lg bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600 transition disabled:opacity-50"
                >
                  {actionLoading === 'unavailable' ? '…' : 'Mark Unavailable'}
                </button>
              )}
            </div>
            {actionError && (
              <p className="w-full text-sm text-red-400 mt-1">{actionError}</p>
            )}
          </div>
        )}

        <div className="grid md:grid-cols-2 gap-8">

          {/* Image gallery */}
          <div>
            <div className="aspect-square bg-gray-100 dark:bg-gray-800 rounded-xl overflow-hidden flex items-center justify-center mb-3 relative">
              {hasImages ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={detailImages[activeImage]}
                  alt={listing.title}
                  className={`w-full h-full object-cover ${isInactive ? 'opacity-60' : ''}`}
                />
              ) : (
                <span className="text-7xl">🏪</span>
              )}
              {isSold && (
                <div className="absolute top-3 left-3 px-3 py-1 bg-red-600 text-white text-sm font-bold rounded-lg">
                  SOLD
                </div>
              )}
              {isRented && (
                <div className="absolute top-3 left-3 px-3 py-1 bg-blue-600 text-white text-sm font-bold rounded-lg">
                  RENTED
                </div>
              )}
              {isUnavailable && (
                <div className="absolute top-3 left-3 px-3 py-1 bg-gray-600 text-white text-sm font-bold rounded-lg">
                  UNAVAILABLE
                </div>
              )}
            </div>

            {hasImages && detailImages.length > 1 && (
              <div className="flex gap-2 flex-wrap">
                {thumbImages.map((src, i) => (
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
            <div className="flex items-center gap-3">
              <PriceDisplay
                price={listing.price}
                currency={listing.currency}
                className={`text-3xl font-bold ${
                  isSold || isRented ? 'line-through text-gray-500' : 'text-orange-500'
                }`}
              />
              {isSold && (
                <span className="px-2 py-0.5 bg-red-900/50 text-red-400 border border-red-700/50 rounded text-sm font-bold">
                  SOLD
                </span>
              )}
              {isRented && (
                <span className="px-2 py-0.5 bg-blue-900/50 text-blue-400 border border-blue-700/50 rounded text-sm font-bold">
                  RENTED
                </span>
              )}
              {isUnavailable && (
                <span className="px-2 py-0.5 bg-gray-800 text-gray-400 border border-gray-700 rounded text-sm font-bold">
                  UNAVAILABLE
                </span>
              )}
            </div>

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
              {isRental && (
                <span className="text-sm px-3 py-1 rounded-full font-medium bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300">
                  Rental
                </span>
              )}
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
                href={`/seller/${encodeURIComponent(sellerHandle ?? listing.sellerDid)}`}
                className="text-sm text-orange-500 hover:text-orange-600 transition break-all"
              >
                {sellerName ?? truncateDid(listing.sellerDid)}
              </a>
              <p className="text-xs text-gray-500 mt-1">
                Listed {formatRelativeTime(listing.createdAt)}
              </p>
            </div>

            {/* Direct Sale: always show contact info */}
            {listing.sellerTier === 'public_offplatform' && listing.contactInfo && (
              <ContactSection contactInfo={listing.contactInfo} />
            )}

            {/* On-platform/Trust-gated with showContactInfo: show contact info */}
            {isOnplatform && listing.showContactInfo && listing.contactInfo && (
              <ContactSection contactInfo={listing.contactInfo} />
            )}

            {/* On-platform: Buy/Rent button (only when active) */}
            {isOnplatform && !isInactive && listing.sellerTier !== 'trust_gated' && (
              <OnboardGate
                action={isRental ? 'rent this item' : 'purchase this item'}
                onIdentity={() => handleBuyNow()}
                authUrl={process.env.NEXT_PUBLIC_AUTH_URL}
              >
                <div className="flex flex-col gap-2">
                  <button
                    disabled={buyLoading}
                    className="px-6 py-3 bg-orange-500 text-white rounded-xl font-semibold hover:bg-orange-600 transition hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {buyLoading ? 'Processing…' : isRental ? 'Rent Now' : 'Buy Now'}
                  </button>
                  {buyError && (
                    <p className="text-sm text-red-500">{buyError}</p>
                  )}
                </div>
              </OnboardGate>
            )}

            {/* Trust-gated: requires verified identity (hard DID) */}
            {listing.sellerTier === 'trust_gated' && !isInactive && (
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleBuyNow}
                  disabled={buyLoading}
                  className="px-6 py-3 bg-orange-500 text-white rounded-xl font-semibold hover:bg-orange-600 transition hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  {buyLoading ? 'Processing…' : isRental ? 'Rent Now' : 'Buy Now'}
                </button>
                {buyError && (
                  <p className="text-sm text-red-500">{buyError}</p>
                )}
                <p className="text-xs text-gray-500">
                  🔒 Requires a verified identity to purchase
                </p>
              </div>
            )}

            {/* Metadata */}
            <div className="text-xs text-gray-400 dark:text-gray-500 space-y-1 pt-2 border-t border-gray-100 dark:border-gray-800">
              <p>Posted {formatRelativeTime(listing.createdAt)}</p>
              <p className="font-mono">{listing.id}</p>
            </div>

          </div>
        </div>

        {/* Other listings by seller */}
        {otherListings.length > 0 && (
          <div className="mt-12">
            <h2 className="text-lg font-semibold text-gray-100 mb-4">More from this seller</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              {otherListings.map((rel) => {
                const relImages = Array.isArray(rel.images) ? rel.images : [];
                const relPrimary = relImages.find((img): img is string => typeof img === 'string' && img.length > 0);
                const relImg = relPrimary ? resolveMediaRef(relPrimary, 'card') : undefined;
                return (
                  <Link
                    key={rel.id}
                    href={`/listings/${rel.id}`}
                    className="group bg-gray-900 border border-gray-800 rounded-xl overflow-hidden hover:border-gray-600 transition-all duration-200 hover:scale-[1.01] flex flex-col"
                  >
                    <div className="aspect-video bg-gradient-to-br from-gray-800 to-gray-700 relative overflow-hidden">
                      {relImg ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={relImg} alt={rel.title} className="w-full h-full object-cover" />
                      ) : (
                        <div className="absolute inset-0 flex items-center justify-center text-gray-600">
                          <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                          </svg>
                        </div>
                      )}
                    </div>
                    <div className="p-3">
                      <p className="text-sm font-medium text-gray-100 group-hover:text-amber-400 transition-colors line-clamp-2">
                        {rel.title}
                      </p>
                      <PriceDisplay
                        price={rel.price}
                        currency={rel.currency}
                        className="text-sm font-bold text-amber-400 mt-1"
                      />
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
