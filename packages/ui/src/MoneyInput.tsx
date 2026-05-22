'use client';

import React, { useMemo } from 'react';
import type { Money } from '@imajin/fair';

interface MoneyInputProps {
  value?: Money;
  onChange: (value: Money | undefined) => void;
  readOnly?: boolean;
  className?: string;
  currencies?: string[];
}

const DEFAULT_CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'MJNX'];

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  CAD: 'C$',
  MJNX: 'Ⓜ',
};

function formatCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

function parseDecimalInput(raw: string): number | null {
  const cleaned = raw.replace(/,/g, '');
  const parsed = Number.parseFloat(cleaned);
  if (Number.isNaN(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

export function MoneyInput({
  value,
  onChange,
  readOnly = false,
  className = '',
  currencies = DEFAULT_CURRENCIES,
}: MoneyInputProps) {
  const symbol = value ? (CURRENCY_SYMBOLS[value.currency] ?? value.currency) : '$';

  const formattedPreview = useMemo(() => {
    if (!value) return '';
    const amt = (value.amount / 100).toFixed(2);
    return `${symbol}${amt} ${value.currency}`;
  }, [value, symbol]);

  return (
    <div className={`space-y-1 ${className}`}>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-gray-500 pointer-events-none">
            {symbol}
          </span>
          <input
            type="text"
            inputMode="decimal"
            value={value ? formatCents(value.amount) : ''}
            onChange={(e) => {
              const cents = parseDecimalInput(e.target.value);
              if (cents === null) {
                onChange(undefined);
                return;
              }
              onChange({
                amount: cents,
                currency: value?.currency ?? currencies[0],
              });
            }}
            placeholder="0.00"
            readOnly={readOnly}
            className="w-full bg-[#1a1a1a] border border-gray-700 rounded pl-6 pr-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-orange-500 read-only:opacity-60"
          />
        </div>
        <select
          value={value?.currency ?? currencies[0]}
          onChange={(e) => {
            const currency = e.target.value;
            const amount = value?.amount ?? 0;
            if (amount === 0 && !value) {
              onChange(undefined);
            } else {
              onChange({ amount, currency });
            }
          }}
          disabled={readOnly}
          className="bg-[#1a1a1a] border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 focus:outline-none focus:border-orange-500 disabled:opacity-60"
        >
          {currencies.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      {value && value.amount > 0 && (
        <p className="text-[10px] text-gray-500">{formattedPreview}</p>
      )}
    </div>
  );
}
