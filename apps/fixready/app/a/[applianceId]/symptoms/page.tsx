'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/button';

export default function SymptomsPage({ params }: { params: { applianceId: string } }) {
  const router = useRouter();
  const [appliance, setAppliance] = useState<any>(null);
  const [symptoms, setSymptoms] = useState<any[]>([]);
  const [selectedSymptom, setSelectedSymptom] = useState<string>('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const applianceRes = await fetch(`/api/appliances/${params.applianceId}`);
        const applianceData = await applianceRes.json();
        setAppliance(applianceData);

        // Load symptoms from YAML file via a simple fetch
        // In production, this would be an API endpoint
        const symptomsRes = await fetch(`/data/symptoms/${applianceData.type}.yaml`);
        const symptomsText = await symptomsRes.text();

        // For MVP, we'll parse YAML on client side
        // In production, use an API endpoint
        // For now, we'll hardcode some common symptoms based on type
        const commonSymptoms = getCommonSymptoms(applianceData.type);
        setSymptoms(commonSymptoms);
      } catch (error) {
        console.error('Error loading data:', error);
      } finally {
        setLoading(false);
      }
    }

    loadData();
  }, [params.applianceId]);

  const handleContinue = () => {
    if (selectedSymptom) {
      sessionStorage.setItem('symptom_category', selectedSymptom);
      router.push(`/a/${params.applianceId}/details`);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-md mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-2">
          What's going wrong?
        </h1>
        <p className="text-gray-600 mb-6">
          Select the option that best describes the problem
        </p>

        <div className="space-y-3 mb-6">
          {symptoms.map((symptom) => (
            <button
              key={symptom.id}
              onClick={() => setSelectedSymptom(symptom.id)}
              className={`
                w-full p-4 rounded-lg border-2 text-left transition-all
                ${
                  selectedSymptom === symptom.id
                    ? 'border-blue-600 bg-blue-50'
                    : 'border-gray-200 bg-white hover:border-gray-300'
                }
              `}
            >
              <div className="font-medium text-gray-900">{symptom.label}</div>
            </button>
          ))}
        </div>

        <Button
          fullWidth
          onClick={handleContinue}
          disabled={!selectedSymptom}
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

function getCommonSymptoms(type: string) {
  const symptomsMap: Record<string, any[]> = {
    washer: [
      { id: 'not_draining', label: "Won't drain / water stays in drum" },
      { id: 'not_spinning', label: "Won't spin" },
      { id: 'leaking', label: 'Leaking water' },
      { id: 'noisy', label: 'Making unusual noises' },
      { id: 'wont_start', label: "Won't start at all" },
      { id: 'other', label: 'Something else' },
    ],
    dryer: [
      { id: 'not_heating', label: 'Not heating / clothes stay wet' },
      { id: 'wont_start', label: "Won't start at all" },
      { id: 'noisy', label: 'Making loud noises' },
      { id: 'overheating', label: 'Getting too hot / burning smell' },
      { id: 'takes_too_long', label: 'Takes forever to dry' },
      { id: 'other', label: 'Something else' },
    ],
    fridge: [
      { id: 'not_cooling', label: 'Not cooling / too warm' },
      { id: 'leaking_water', label: 'Leaking water' },
      { id: 'noisy', label: 'Making loud or unusual noises' },
      { id: 'ice_maker_problem', label: 'Ice maker not working' },
      { id: 'too_cold_freezing', label: 'Too cold / freezing food' },
      { id: 'other', label: 'Something else' },
    ],
    dishwasher: [
      { id: 'not_cleaning', label: 'Not cleaning dishes properly' },
      { id: 'not_draining', label: 'Not draining / water in bottom' },
      { id: 'leaking', label: 'Leaking water' },
      { id: 'not_filling', label: 'Not filling with water' },
      { id: 'noisy', label: 'Making loud or unusual noises' },
      { id: 'wont_start', label: "Won't start at all" },
      { id: 'other', label: 'Something else' },
    ],
  };

  return symptomsMap[type] || [{ id: 'other', label: 'Describe the problem' }];
}
