'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/button';
import { Input } from '@/components/input';
import { Select } from '@/components/select';

const COMMON_BRANDS = [
  'LG', 'Samsung', 'Whirlpool', 'GE', 'Frigidaire', 'Maytag',
  'KitchenAid', 'Bosch', 'Electrolux', 'Kenmore', 'Other'
];

const AGE_RANGES = [
  { value: '<5', label: 'Less than 5 years' },
  { value: '5-10', label: '5-10 years' },
  { value: '10+', label: 'More than 10 years' },
];

export default function IdentifyPage({ params }: { params: { token: string } }) {
  const router = useRouter();
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [serial, setSerial] = useState('');
  const [ageRange, setAgeRange] = useState('');
  const [showHelp, setShowHelp] = useState(false);

  const handleContinue = () => {
    sessionStorage.setItem('appliance_brand', brand);
    sessionStorage.setItem('appliance_model', model);
    sessionStorage.setItem('appliance_serial', serial);
    sessionStorage.setItem('appliance_age_range', ageRange);
    router.push(`/go/${params.token}/location`);
  };

  const canContinue = brand && model && ageRange;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-md mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">
          Appliance Details
        </h1>

        <div className="space-y-4 mb-6">
          <Select
            label="Brand"
            required
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            options={COMMON_BRANDS.map(b => ({ value: b, label: b }))}
          />

          <Input
            label="Model Number"
            required
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="e.g., WM3500CW"
          />

          <Input
            label="Serial Number (Optional)"
            value={serial}
            onChange={(e) => setSerial(e.target.value)}
            placeholder="e.g., 12345ABC"
          />

          <Select
            label="Approximate Age"
            required
            value={ageRange}
            onChange={(e) => setAgeRange(e.target.value)}
            options={AGE_RANGES}
          />
        </div>

        <button
          onClick={() => setShowHelp(!showHelp)}
          className="text-sm text-blue-600 hover:underline mb-4"
        >
          Where to find model/serial numbers?
        </button>

        {showHelp && (
          <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 mb-4 text-sm text-gray-700">
            <p className="font-medium mb-2">Tip:</p>
            <p>
              Look for a label inside the door, behind a panel, or near the power connection.
              The model number is usually more prominent than the serial number.
            </p>
          </div>
        )}

        <Button
          fullWidth
          onClick={handleContinue}
          disabled={!canContinue}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
