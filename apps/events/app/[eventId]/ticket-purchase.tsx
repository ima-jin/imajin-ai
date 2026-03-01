'use client';

import { useState } from 'react';
import type { TicketType } from '@/src/db/schema';

interface Props {
  eventId: string;
  eventTitle: string;
  ticket: TicketType;
}

export function TicketPurchase({ eventId, eventTitle, ticket }: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  const available = ticket.quantity === null 
    ? 'Unlimited' 
    : `${ticket.quantity - (ticket.sold ?? 0)} left`;
  
  const soldOut = ticket.quantity !== null && (ticket.sold ?? 0) >= ticket.quantity;
  
  const handlePurchase = async () => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId,
          ticketTypeId: ticket.id,
          quantity: 1,
        }),
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to create checkout');
      }
      
      const { url } = await response.json();
      
      // Redirect to Stripe Checkout
      window.location.href = url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setLoading(false);
    }
  };
  
  const formatPrice = (cents: number, currency: string) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
    }).format(cents / 100);
  };
  
  return (
    <>
      {error && (
        <p className="text-red-500 text-xs mb-2">{error}</p>
      )}
      <button
        onClick={handlePurchase}
        disabled={loading || soldOut}
        className={`px-6 md:px-8 py-2.5 md:py-3 rounded-lg font-semibold transition whitespace-nowrap ${
          soldOut
            ? 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
            : loading
            ? 'bg-orange-400 text-white cursor-wait'
            : 'bg-orange-500 text-white hover:bg-orange-600'
        }`}
      >
        {soldOut ? 'Sold Out' : loading ? 'Loading...' : 'Get Ticket'}
      </button>
    </>
  );
}
