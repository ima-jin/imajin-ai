'use client'; export const ZERO_DECIMAL_CURRENCIES = new Set([ 'JPY', 'KRW', 'VND', 'CLP', 'BIF', 'DJF', 'GNF', 'ISK', 'KMF', 'PYG', 'RWF', 'UGX', 'VUV', 'XAF', 'XOF', 'XPF',
]); interface PriceDisplayProps { price: number; currency: string; className?: string;
} export default function PriceDisplay({ price, currency, className }: PriceDisplayProps) { const code = currency.toUpperCase(); const value = ZERO_DECIMAL_CURRENCIES.has(code) ? price : price / 100; const formatted = new Intl.NumberFormat('en-US', { style: 'currency', currency: code, }).format(value); return <span className={className}>{formatted}</span>;
}
