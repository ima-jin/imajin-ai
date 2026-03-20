'use client';

import { useRouter, useSearchParams, usePathname } from 'next/navigation';
import { useCallback, useRef } from 'react';

const CURRENCIES = ['CAD', 'USD', 'EUR', 'GBP', 'CHF', 'AUD', 'JPY', 'ZAR'];

export default function SearchFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const updateParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      params.delete('page');
      router.push(`${pathname}?${params.toString()}`);
    },
    [router, pathname, searchParams]
  );

  const handleSearch = useCallback(
    (value: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => updateParam('category', value), 400);
    },
    [updateParam]
  );

  const tier = searchParams.get('tier') || 'all';
  const currency = searchParams.get('currency') || '';
  const sort = searchParams.get('sort') || 'newest';
  const category = searchParams.get('category') || '';

  return (
    <div className="flex flex-col sm:flex-row gap-3 mb-6">
      {/* Search */}
      <div className="relative flex-1">
        <svg
          className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          type="text"
          placeholder="Search by category..."
          defaultValue={category}
          onChange={(e) => handleSearch(e.target.value)}
          className="w-full pl-9 pr-4 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-gray-500"
        />
      </div>

      {/* Currency */}
      <select
        value={currency}
        onChange={(e) => updateParam('currency', e.target.value)}
        className="px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-gray-500"
      >
        <option value="">All Currencies</option>
        {CURRENCIES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      {/* Tier toggle */}
      <div className="flex rounded-lg border border-gray-700 overflow-hidden">
        {(['all', 'direct', 'protected'] as const).map((t) => {
          const active = tier === t || (t === 'all' && !searchParams.get('tier'));
          return (
            <button
              key={t}
              onClick={() => updateParam('tier', t === 'all' ? '' : t)}
              className={`px-3 py-2 text-sm transition ${
                active
                  ? 'bg-gray-700 text-white'
                  : 'bg-gray-900 text-gray-400 hover:bg-gray-800'
              }`}
            >
              {t === 'all' ? 'All' : t === 'direct' ? 'Direct' : 'Protected'}
            </button>
          );
        })}
      </div>

      {/* Sort */}
      <select
        value={sort}
        onChange={(e) => updateParam('sort', e.target.value)}
        className="px-3 py-2 bg-gray-900 border border-gray-700 rounded-lg text-sm text-gray-200 focus:outline-none focus:border-gray-500"
      >
        <option value="newest">Newest</option>
        <option value="price_asc">Price ↑</option>
        <option value="price_desc">Price ↓</option>
      </select>
    </div>
  );
}
