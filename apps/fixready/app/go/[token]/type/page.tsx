'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/button';

const APPLIANCE_TYPES = [
  { value: 'fridge', label: 'Refrigerator', icon: '❄️' },
  { value: 'dishwasher', label: 'Dishwasher', icon: '🍽️' },
  { value: 'washer', label: 'Washer', icon: '🧺' },
  { value: 'dryer', label: 'Dryer', icon: '👕' },
  { value: 'oven', label: 'Oven/Range', icon: '🔥' },
  { value: 'hvac', label: 'HVAC', icon: '🌡️' },
  { value: 'other', label: 'Other', icon: '🔧' },
];

export default function SelectTypePage({ params }: { params: { token: string } }) {
  const router = useRouter();
  const [selectedType, setSelectedType] = useState<string>('');

  const handleContinue = () => {
    if (selectedType) {
      sessionStorage.setItem('appliance_type', selectedType);
      router.push(`/go/${params.token}/identify`);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-md mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">
          What type of appliance?
        </h1>

        <div className="grid grid-cols-2 gap-3 mb-6">
          {APPLIANCE_TYPES.map((type) => (
            <button
              key={type.value}
              onClick={() => setSelectedType(type.value)}
              className={`
                p-4 rounded-lg border-2 transition-all text-left
                ${
                  selectedType === type.value
                    ? 'border-blue-600 bg-blue-50'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }
              `}
            >
              <div className="text-3xl mb-2">{type.icon}</div>
              <div className="font-medium text-gray-900">{type.label}</div>
            </button>
          ))}
        </div>

        <Button
          fullWidth
          onClick={handleContinue}
          disabled={!selectedType}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
