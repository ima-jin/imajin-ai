'use client';

import { ImajinFooter } from '@imajin/ui';

export default function MarketPage() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-gray-50 to-gray-100 dark:from-gray-900 dark:to-black">
      <div className="container mx-auto px-4 py-16">
        <div className="max-w-2xl mx-auto text-center">
          <div className="text-6xl mb-4">🏪</div>

          <h1 className="text-4xl font-bold mb-4">
            market.imajin.ai
          </h1>

          <p className="text-xl text-gray-600 dark:text-gray-400 mb-8">
            Local commerce with trust.
            <br />
            Buy and sell with your community. No middlemen.
          </p>

          <ImajinFooter className="mt-8" />
        </div>
      </div>
    </div>
  );
}
