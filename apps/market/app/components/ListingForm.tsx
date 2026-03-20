'use client';

import { useState } from 'react';
import { ImageUpload } from './ImageUpload';

const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'BIF', 'DJF', 'GNF', 'ISK',
  'KMF', 'PYG', 'RWF', 'UGX', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const CURRENCIES = [
  { code: 'CAD', symbol: 'CA$' },
  { code: 'USD', symbol: '$' },
  { code: 'EUR', symbol: '€' },
  { code: 'GBP', symbol: '£' },
  { code: 'CHF', symbol: 'Fr' },
  { code: 'AUD', symbol: 'A$' },
  { code: 'JPY', symbol: '¥' },
  { code: 'ZAR', symbol: 'R' },
  { code: 'NZD', symbol: 'NZ$' },
  { code: 'SEK', symbol: 'kr' },
  { code: 'MXN', symbol: 'MX$' },
  { code: 'SGD', symbol: 'S$' },
];

export interface ListingFormData {
  title: string;
  description: string;
  price: number; // in smallest unit (cents)
  currency: string;
  category: string;
  quantity: number | null;
  images: string[];
  sellerTier: 'public_offplatform' | 'public_onplatform';
  contactInfo: {
    phone: string;
    email: string;
    whatsapp: string;
  };
}

interface ListingFormProps {
  initialData?: Partial<ListingFormData & { price: number }>;
  onSubmit: (data: ListingFormData) => void;
  submitLabel: string;
  isLoading: boolean;
  error?: string;
}

// Convert smallest-unit price to display value
function toDisplayPrice(price: number | undefined, currency: string): string {
  if (price === undefined || price === 0) return '';
  const code = currency.toUpperCase();
  const display = ZERO_DECIMAL_CURRENCIES.has(code) ? price : price / 100;
  return String(display);
}

export function ListingForm({ initialData, onSubmit, submitLabel, isLoading, error }: ListingFormProps) {
  const [title, setTitle] = useState(initialData?.title ?? '');
  const [description, setDescription] = useState(initialData?.description ?? '');
  const [currency, setCurrency] = useState(initialData?.currency ?? 'CAD');
  const [priceDisplay, setPriceDisplay] = useState(
    toDisplayPrice(initialData?.price, initialData?.currency ?? 'CAD')
  );
  const [category, setCategory] = useState(initialData?.category ?? '');
  const [quantityStr, setQuantityStr] = useState(
    initialData?.quantity !== undefined && initialData.quantity !== null
      ? String(initialData.quantity)
      : '1'
  );
  const [images, setImages] = useState<string[]>(initialData?.images ?? []);
  const [sellerTier, setSellerTier] = useState<'public_offplatform' | 'public_onplatform'>(
    (initialData?.sellerTier as 'public_offplatform' | 'public_onplatform') ?? 'public_offplatform'
  );
  const [phone, setPhone] = useState(initialData?.contactInfo?.phone ?? '');
  const [email, setEmail] = useState(initialData?.contactInfo?.email ?? '');
  const [whatsapp, setWhatsapp] = useState(initialData?.contactInfo?.whatsapp ?? '');
  const [validationError, setValidationError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setValidationError('');

    if (!title.trim()) {
      setValidationError('Title is required.');
      return;
    }

    const priceNum = parseFloat(priceDisplay);
    if (!priceDisplay || isNaN(priceNum) || priceNum <= 0) {
      setValidationError('Price must be greater than 0.');
      return;
    }

    if (sellerTier === 'public_offplatform' && !phone && !email && !whatsapp) {
      setValidationError('At least one contact method is required for Direct Sale.');
      return;
    }

    // Convert display price to smallest unit
    const code = currency.toUpperCase();
    const price = ZERO_DECIMAL_CURRENCIES.has(code)
      ? Math.round(priceNum)
      : Math.round(priceNum * 100);

    const quantity = quantityStr.trim() ? parseInt(quantityStr, 10) : null;

    onSubmit({
      title: title.trim(),
      description: description.trim(),
      price,
      currency,
      category: category.trim(),
      quantity,
      images,
      sellerTier,
      contactInfo: { phone, email, whatsapp },
    });
  };

  const displayError = validationError || error;

  return (
    <form onSubmit={handleSubmit} className="space-y-8">

      {/* Item Details */}
      <section>
        <h2 className="text-lg font-semibold text-gray-100 mb-4 pb-2 border-b border-gray-800">
          Item Details
        </h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1" htmlFor="title">
              Title <span className="text-red-400">*</span>
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={200}
              required
              placeholder="What are you selling?"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1" htmlFor="description">
              Description <span className="text-red-400">*</span>
            </label>
            <textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              required
              placeholder="Describe your item — condition, size, age, reason for selling..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
            />
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1" htmlFor="category">
              Category
            </label>
            <input
              id="category"
              type="text"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="e.g. Electronics, Furniture, Clothing..."
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section>
        <h2 className="text-lg font-semibold text-gray-100 mb-4 pb-2 border-b border-gray-800">
          Pricing
        </h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1" htmlFor="price">
                Price <span className="text-red-400">*</span>
              </label>
              <input
                id="price"
                type="number"
                value={priceDisplay}
                onChange={(e) => setPriceDisplay(e.target.value)}
                min="0.01"
                step="0.01"
                required
                placeholder="0.00"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1" htmlFor="currency">
                Currency
              </label>
              <select
                id="currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              >
                {CURRENCIES.map(({ code, symbol }) => (
                  <option key={code} value={code}>
                    {code} ({symbol})
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-sm text-gray-400 mb-1" htmlFor="quantity">
              Quantity
            </label>
            <input
              id="quantity"
              type="number"
              value={quantityStr}
              onChange={(e) => setQuantityStr(e.target.value)}
              min="1"
              step="1"
              placeholder="1"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
            <p className="mt-1 text-xs text-gray-500">Leave empty for services or unlimited stock</p>
          </div>
        </div>
      </section>

      {/* Images */}
      <section>
        <h2 className="text-lg font-semibold text-gray-100 mb-4 pb-2 border-b border-gray-800">
          Images
        </h2>
        <ImageUpload images={images} onChange={setImages} />
      </section>

      {/* Sale Type */}
      <section>
        <h2 className="text-lg font-semibold text-gray-100 mb-4 pb-2 border-b border-gray-800">
          Sale Type
        </h2>
        <div className="space-y-3">
          <label
            className={`flex items-start gap-4 p-4 rounded-lg border cursor-pointer transition ${
              sellerTier === 'public_offplatform'
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-gray-700 hover:border-gray-600'
            }`}
          >
            <input
              type="radio"
              name="sellerTier"
              value="public_offplatform"
              checked={sellerTier === 'public_offplatform'}
              onChange={() => setSellerTier('public_offplatform')}
              className="mt-0.5 accent-blue-500"
            />
            <div>
              <p className="font-medium text-gray-100">Direct Sale</p>
              <p className="text-sm text-gray-400">Buyers contact you directly. No platform involvement.</p>
            </div>
          </label>

          <label
            className={`flex items-start gap-4 p-4 rounded-lg border cursor-pointer transition ${
              sellerTier === 'public_onplatform'
                ? 'border-blue-500 bg-blue-500/10'
                : 'border-gray-700 hover:border-gray-600'
            }`}
          >
            <input
              type="radio"
              name="sellerTier"
              value="public_onplatform"
              checked={sellerTier === 'public_onplatform'}
              onChange={() => setSellerTier('public_onplatform')}
              className="mt-0.5 accent-blue-500"
            />
            <div>
              <p className="font-medium text-gray-100">Protected Sale</p>
              <p className="text-sm text-gray-400">Transaction through Imajin. 1% fee. Buyer protection.</p>
            </div>
          </label>
        </div>

        {/* Contact info — Direct Sale only */}
        {sellerTier === 'public_offplatform' && (
          <div className="mt-4 p-4 bg-gray-900 rounded-lg border border-gray-700 space-y-4">
            <p className="text-sm text-gray-400 font-medium">
              Contact Info <span className="text-gray-500">(at least one required)</span>
            </p>

            <div>
              <label className="block text-sm text-gray-400 mb-1" htmlFor="phone">Phone</label>
              <input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+1 555 000 0000"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1" htmlFor="contactEmail">Email</label>
              <input
                id="contactEmail"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label className="block text-sm text-gray-400 mb-1" htmlFor="whatsapp">WhatsApp</label>
              <input
                id="whatsapp"
                type="text"
                value={whatsapp}
                onChange={(e) => setWhatsapp(e.target.value)}
                placeholder="+1 555 000 0000"
                className="w-full bg-gray-800 border border-gray-700 rounded-lg px-4 py-2.5 text-gray-100 placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>
        )}
      </section>

      {/* Error */}
      {displayError && (
        <div className="p-4 bg-red-900/30 border border-red-800 rounded-lg">
          <p className="text-sm text-red-400">{displayError}</p>
        </div>
      )}

      {/* Submit */}
      <button
        type="submit"
        disabled={isLoading}
        className="w-full py-3 px-6 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg transition"
      >
        {isLoading ? 'Saving...' : submitLabel}
      </button>
    </form>
  );
}
