'use client';

import type { LineItemDraft } from '../lib/types';

interface Props {
  items: LineItemDraft[];
  currency: string;
  onChange: (items: LineItemDraft[]) => void;
}

const INPUT_CLASSES =
  'w-full bg-black border border-zinc-700 rounded-lg px-3 py-2 text-sm text-white placeholder-zinc-600 focus:border-amber-500 focus:outline-none';

/** Line items (name, qty, unit amount) for a payment_request's create form (#2211). Currency is a request-level field, shown alongside for context. */
export default function LineItemsEditor({ items, currency, onChange }: Readonly<Props>) {
  function update(index: number, patch: Partial<LineItemDraft>) {
    onChange(items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function remove(index: number) {
    onChange(items.filter((_, i) => i !== index));
  }

  function add() {
    const key = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `item-${items.length}-${Date.now()}`;
    onChange([...items, { key, name: '', description: '', quantity: '1', unitAmount: '' }]);
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-12 gap-2 text-xs text-zinc-500 px-1">
        <span className="col-span-5">Item</span>
        <span className="col-span-2">Qty</span>
        <span className="col-span-3">Unit amount ({currency})</span>
      </div>
      {items.map((item, index) => (
        <div key={item.key} className="grid grid-cols-12 gap-2 items-center">
          <div className="col-span-5">
            <label htmlFor={`line-item-name-${item.key}`} className="sr-only">
              Item name
            </label>
            <input
              id={`line-item-name-${item.key}`}
              type="text"
              value={item.name}
              onChange={(e) => update(index, { name: e.target.value })}
              placeholder="Item name"
              className={INPUT_CLASSES}
            />
          </div>
          <div className="col-span-2">
            <label htmlFor={`line-item-qty-${item.key}`} className="sr-only">
              Quantity
            </label>
            <input
              id={`line-item-qty-${item.key}`}
              type="number"
              min={1}
              step={1}
              value={item.quantity}
              onChange={(e) => update(index, { quantity: e.target.value })}
              placeholder="1"
              className={INPUT_CLASSES}
            />
          </div>
          <div className="col-span-3">
            <label htmlFor={`line-item-amount-${item.key}`} className="sr-only">
              Unit amount
            </label>
            <input
              id={`line-item-amount-${item.key}`}
              type="text"
              inputMode="decimal"
              value={item.unitAmount}
              onChange={(e) => update(index, { unitAmount: e.target.value })}
              placeholder="0.00"
              className={INPUT_CLASSES}
            />
          </div>
          <div className="col-span-2 flex justify-end">
            {items.length > 1 && (
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label={`Remove line item ${index + 1}`}
                className="text-zinc-500 hover:text-red-400 text-sm px-2"
              >
                ✕
              </button>
            )}
          </div>
        </div>
      ))}
      <button type="button" onClick={add} className="text-xs text-amber-400 hover:text-amber-300 transition-colors">
        + Add line item
      </button>
    </div>
  );
}
