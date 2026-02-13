'use client';

import { useState, useEffect } from 'react';

interface Group {
  id: string;
  name: string;
  memberCount: number;
}

interface GroupSummary {
  name: string;
  householdCount: number;
  totalExtraction: number;
  breakdown: Record<string, number>;
}

const CATEGORIES = [
  { key: 'streaming', label: 'Streaming', emoji: '🎬', hint: 'Netflix, Spotify, Disney+, Apple TV' },
  { key: 'rideshare', label: 'Rideshare / Delivery', emoji: '🚗', hint: 'Uber, Lyft, DoorDash, Skip' },
  { key: 'cloud', label: 'Cloud / Storage', emoji: '☁️', hint: 'iCloud, Google One, Dropbox' },
  { key: 'software', label: 'Software Subscriptions', emoji: '📱', hint: 'Adobe, Microsoft 365, Notion' },
  { key: 'memberships', label: 'Memberships', emoji: '🛒', hint: 'Amazon Prime, Costco' },
  { key: 'internet', label: 'Internet / Phone', emoji: '🌐', hint: 'Rogers, Bell, Telus' },
  { key: 'utilities', label: 'Utilities', emoji: '⚡', hint: 'Hydro, gas, heat' },
  { key: 'rent', label: 'Rent / Mortgage', emoji: '🏦', hint: 'Monthly housing cost' },
  { key: 'other', label: 'Other Recurring', emoji: '💳', hint: 'Anything else monthly' },
] as const;

export function SpendingForm() {
  const [step, setStep] = useState<'form' | 'summary'>('form');
  
  // Form state
  const [householdSize, setHouseholdSize] = useState(1);
  const [postalCode, setPostalCode] = useState('');
  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [newGroupName, setNewGroupName] = useState('');
  const [spending, setSpending] = useState<Record<string, number>>(
    Object.fromEntries(CATEGORIES.map(c => [c.key, 0]))
  );
  
  // Data state
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupSummaries, setGroupSummaries] = useState<GroupSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  // Fetch groups on mount
  useEffect(() => {
    fetch('/api/groups')
      .then(r => r.json())
      .then(setGroups)
      .catch(console.error);
  }, []);

  const toggleGroup = (id: string) => {
    setSelectedGroups(prev => 
      prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]
    );
  };

  const createGroup = async () => {
    if (!newGroupName.trim()) return;
    
    try {
      const res = await fetch('/api/groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newGroupName.trim() }),
      });
      const newGroup = await res.json();
      
      if (newGroup.id) {
        setGroups(prev => {
          const exists = prev.some(g => g.id === newGroup.id);
          if (exists) return prev;
          return [...prev, { ...newGroup, memberCount: newGroup.memberCount || 0 }];
        });
        setSelectedGroups(prev => [...prev, newGroup.id]);
        setNewGroupName('');
      }
    } catch (e) {
      console.error('Failed to create group:', e);
    }
  };

  const handleSubmit = async () => {
    setLoading(true);
    setError('');
    
    try {
      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          householdSize,
          postalCode: postalCode || undefined,
          groupIds: selectedGroups,
          spending,
        }),
      });
      
      const data = await res.json();
      
      if (data.success) {
        setGroupSummaries(data.groupSummaries || []);
        setStep('summary');
      } else {
        setError(data.error || 'Something went wrong');
      }
    } catch (e) {
      setError('Failed to submit');
    } finally {
      setLoading(false);
    }
  };

  const total = Object.values(spending).reduce((a, b) => a + b, 0);

  if (step === 'summary') {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <h2 className="text-3xl font-bold mb-2">Thanks for contributing 🔥</h2>
        <p className="text-gray-400 mb-8">Your community's data:</p>
        
        {groupSummaries.length > 0 ? (
          groupSummaries.map(summary => (
            <div key={summary.name} className="bg-zinc-900 rounded-lg p-6 mb-4">
              <h3 className="text-xl font-semibold mb-1">{summary.name}</h3>
              <p className="text-gray-400 mb-4">{summary.householdCount} household{summary.householdCount !== 1 ? 's' : ''} reporting</p>
              
              <div className="text-2xl font-bold text-orange-500 mb-4">
                ${summary.totalExtraction.toLocaleString()}/month extracted
              </div>
              
              <div className="space-y-2 text-sm">
                {CATEGORIES.map(cat => {
                  const val = summary.breakdown[cat.key] || 0;
                  if (val === 0) return null;
                  return (
                    <div key={cat.key} className="flex justify-between">
                      <span className="text-gray-400">{cat.emoji} {cat.label}</span>
                      <span>${val.toLocaleString()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        ) : (
          <div className="bg-zinc-900 rounded-lg p-6 mb-4">
            <p className="text-gray-400">Your spending: ${total.toLocaleString()}/month</p>
            <p className="text-sm text-gray-500 mt-2">Join a group to see community totals!</p>
          </div>
        )}
        
        <button
          onClick={() => {
            setStep('form');
            setSpending(Object.fromEntries(CATEGORIES.map(c => [c.key, 0])));
            setSelectedGroups([]);
          }}
          className="mt-6 text-orange-500 hover:text-orange-400"
        >
          ← Submit another
        </button>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h2 className="text-2xl font-bold mb-6">Track Your Extraction</h2>
      
      {/* Household Size */}
      <div className="mb-6">
        <label className="block text-sm text-gray-400 mb-2">Household Size</label>
        <select
          value={householdSize}
          onChange={e => setHouseholdSize(Number(e.target.value))}
          className="bg-zinc-900 border border-zinc-700 rounded px-4 py-2 w-full"
        >
          {[1,2,3,4,5,6,7,8,9,10].map(n => (
            <option key={n} value={n}>{n} {n === 10 ? '+' : ''}</option>
          ))}
        </select>
      </div>
      
      {/* Postal Code */}
      <div className="mb-6">
        <label className="block text-sm text-gray-400 mb-2">Postal Code <span className="text-gray-500">(optional)</span></label>
        <input
          type="text"
          value={postalCode}
          onChange={e => setPostalCode(e.target.value)}
          placeholder="e.g. M5V 1J1"
          className="bg-zinc-900 border border-zinc-700 rounded px-4 py-2 w-full"
        />
      </div>
      
      {/* Groups */}
      <div className="mb-8">
        <label className="block text-sm text-gray-400 mb-2">Social Groups <span className="text-gray-500">(select or create)</span></label>
        
        <div className="flex flex-wrap gap-2 mb-3">
          {groups.map(g => (
            <button
              key={g.id}
              onClick={() => toggleGroup(g.id)}
              className={`px-3 py-1 rounded-full text-sm transition ${
                selectedGroups.includes(g.id)
                  ? 'bg-orange-500 text-black'
                  : 'bg-zinc-800 text-gray-300 hover:bg-zinc-700'
              }`}
            >
              {g.name} ({g.memberCount})
            </button>
          ))}
        </div>
        
        <div className="flex gap-2">
          <input
            type="text"
            value={newGroupName}
            onChange={e => setNewGroupName(e.target.value)}
            placeholder="Create new group..."
            className="bg-zinc-900 border border-zinc-700 rounded px-4 py-2 flex-1"
            onKeyDown={e => e.key === 'Enter' && createGroup()}
          />
          <button
            onClick={createGroup}
            disabled={!newGroupName.trim()}
            className="px-4 py-2 bg-zinc-800 rounded hover:bg-zinc-700 disabled:opacity-50"
          >
            +
          </button>
        </div>
      </div>
      
      {/* Spending Categories */}
      <div className="mb-8">
        <label className="block text-sm text-gray-400 mb-4">Monthly Spending ($/month)</label>
        
        <div className="space-y-4">
          {CATEGORIES.map(cat => (
            <div key={cat.key} className="flex items-center gap-4">
              <div className="w-8 text-xl">{cat.emoji}</div>
              <div className="flex-1">
                <div className="text-sm">{cat.label}</div>
                <div className="text-xs text-gray-500">{cat.hint}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-gray-500">$</span>
                <input
                  type="number"
                  min="0"
                  step="1"
                  value={spending[cat.key] || ''}
                  onChange={e => setSpending(prev => ({ ...prev, [cat.key]: Number(e.target.value) || 0 }))}
                  placeholder="0"
                  className="bg-zinc-900 border border-zinc-700 rounded px-3 py-1 w-24 text-right"
                />
              </div>
            </div>
          ))}
        </div>
        
        <div className="mt-6 pt-4 border-t border-zinc-700 flex justify-between text-lg">
          <span>Total Monthly Extraction</span>
          <span className="font-bold text-orange-500">${total.toLocaleString()}</span>
        </div>
      </div>
      
      {error && (
        <div className="mb-4 p-3 bg-red-900/50 border border-red-700 rounded text-red-200 text-sm">
          {error}
        </div>
      )}
      
      <button
        onClick={handleSubmit}
        disabled={loading || total === 0}
        className="w-full py-3 bg-orange-500 hover:bg-orange-600 text-black font-bold rounded transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? 'Submitting...' : 'Submit'}
      </button>
    </div>
  );
}
