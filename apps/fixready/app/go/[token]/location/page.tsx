'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/button';
import { Input } from '@/components/input';
import { Select } from '@/components/select';

const ROOMS = [
  { value: 'Kitchen', label: 'Kitchen' },
  { value: 'Laundry', label: 'Laundry Room' },
  { value: 'Basement', label: 'Basement' },
  { value: 'Garage', label: 'Garage' },
  { value: 'Other', label: 'Other' },
];

export default function LocationPage({ params }: { params: { token: string } }) {
  const router = useRouter();
  const [address, setAddress] = useState('');
  const [unit, setUnit] = useState('');
  const [room, setRoom] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [saving, setSaving] = useState(false);
  const [partnerData, setPartnerData] = useState<any>(null);

  useEffect(() => {
    async function loadPartner() {
      const response = await fetch(`/api/token/${params.token}`);
      const data = await response.json();
      setPartnerData(data);
    }
    loadPartner();
  }, [params.token]);

  const handleSave = async () => {
    setSaving(true);

    try {
      const applianceData = {
        partnerId: partnerData?.partner?.id,
        tokenId: params.token,
        type: sessionStorage.getItem('appliance_type'),
        brand: sessionStorage.getItem('appliance_brand'),
        model: sessionStorage.getItem('appliance_model'),
        serial: sessionStorage.getItem('appliance_serial') || null,
        ageRange: sessionStorage.getItem('appliance_age_range'),
        address,
        unit: unit || null,
        room,
        contactPhone: contactPhone || null,
        contactEmail: contactEmail || null,
      };

      const response = await fetch('/api/appliances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(applianceData),
      });

      if (!response.ok) {
        throw new Error('Failed to save appliance');
      }

      const appliance = await response.json();

      // Clear session storage
      sessionStorage.clear();

      router.push(`/go/${params.token}/done?applianceId=${appliance.id}`);
    } catch (error) {
      console.error('Error saving appliance:', error);
      alert('Failed to save appliance. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  const canSave = address && room && (contactPhone || contactEmail);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-md mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">
          Location & Contact
        </h1>

        <div className="space-y-4 mb-6">
          <Input
            label="Street Address"
            required
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="123 Main St, City, State ZIP"
          />

          <Input
            label="Unit / Apt # (Optional)"
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            placeholder="Apt 4B"
          />

          <Select
            label="Room / Location"
            required
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            options={ROOMS}
          />

          <div className="border-t pt-4">
            <p className="text-sm text-gray-600 mb-3">
              Preferred contact method (at least one required)
            </p>

            <Input
              label="Phone"
              type="tel"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
              placeholder="(555) 123-4567"
            />

            <div className="my-3 text-center text-sm text-gray-500">or</div>

            <Input
              label="Email"
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </div>
        </div>

        <Button
          fullWidth
          onClick={handleSave}
          disabled={!canSave || saving}
        >
          {saving ? 'Saving...' : 'Save Appliance'}
        </Button>
      </div>
    </div>
  );
}
