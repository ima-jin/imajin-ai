import type { Appliance } from '@/db/schema';

interface ApplianceCardProps {
  appliance: Appliance;
  className?: string;
}

export function ApplianceCard({ appliance, className = '' }: ApplianceCardProps) {
  return (
    <div className={`bg-white rounded-lg border-2 border-gray-200 p-4 ${className}`}>
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="text-sm text-gray-500 uppercase tracking-wide">
            {appliance.type}
          </div>
          <div className="mt-1 text-lg font-semibold">
            {appliance.brand || 'Unknown Brand'}
          </div>
          {appliance.model && (
            <div className="text-sm text-gray-600">Model: {appliance.model}</div>
          )}
          {appliance.serial && (
            <div className="text-xs text-gray-500 mt-1">S/N: {appliance.serial}</div>
          )}
        </div>
      </div>
      <div className="mt-3 pt-3 border-t border-gray-100">
        <div className="text-sm text-gray-600">
          📍 {appliance.address}
          {appliance.unit && ` - ${appliance.unit}`}
        </div>
        {appliance.room && (
          <div className="text-xs text-gray-500 mt-1">
            Location: {appliance.room}
          </div>
        )}
      </div>
    </div>
  );
}
