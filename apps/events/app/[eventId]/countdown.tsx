'use client';

import { useEffect, useState } from 'react';

interface CountdownProps {
  targetDate: string;
}

interface TimeLeft {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
}

function calculateTimeLeft(targetDate: string): TimeLeft | null {
  const difference = new Date(targetDate).getTime() - new Date().getTime();
  
  if (difference <= 0) {
    return null;
  }
  
  return {
    days: Math.floor(difference / (1000 * 60 * 60 * 24)),
    hours: Math.floor((difference / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((difference / 1000 / 60) % 60),
    seconds: Math.floor((difference / 1000) % 60),
  };
}

export function Countdown({ targetDate }: CountdownProps) {
  const [timeLeft, setTimeLeft] = useState<TimeLeft | null>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    setTimeLeft(calculateTimeLeft(targetDate));
    
    const timer = setInterval(() => {
      setTimeLeft(calculateTimeLeft(targetDate));
    }, 1000);

    return () => clearInterval(timer);
  }, [targetDate]);

  // Don't render on server to avoid hydration mismatch
  if (!mounted) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6 mb-8">
        <div className="text-center">
          <p className="text-sm text-gray-500 uppercase tracking-wide mb-4">Event starts in</p>
          <div className="flex justify-center gap-4">
            {['Days', 'Hours', 'Minutes', 'Seconds'].map((label) => (
              <div key={label} className="text-center">
                <div className="text-4xl font-bold text-gray-300">--</div>
                <div className="text-xs text-gray-500 uppercase">{label}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!timeLeft) {
    return (
      <div className="bg-gradient-to-r from-green-500 to-emerald-600 rounded-2xl shadow-lg p-6 mb-8 text-white text-center">
        <p className="text-2xl font-bold">🎉 Event is happening now!</p>
      </div>
    );
  }

  const units = [
    { value: timeLeft.days, label: 'Days' },
    { value: timeLeft.hours, label: 'Hours' },
    { value: timeLeft.minutes, label: 'Minutes' },
    { value: timeLeft.seconds, label: 'Seconds' },
  ];

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-lg p-6 mb-8">
      <div className="text-center">
        <p className="text-sm text-gray-500 uppercase tracking-wide mb-4">Event starts in</p>
        <div className="flex justify-center gap-4 md:gap-8">
          {units.map(({ value, label }) => (
            <div key={label} className="text-center">
              <div className="text-3xl md:text-5xl font-bold bg-gradient-to-br from-orange-500 to-amber-600 bg-clip-text text-transparent">
                {value.toString().padStart(2, '0')}
              </div>
              <div className="text-xs text-gray-500 uppercase mt-1">{label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
