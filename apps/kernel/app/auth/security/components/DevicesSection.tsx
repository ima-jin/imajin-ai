'use client';

export interface Device {
  id: string;
  fingerprint: string;
  name: string | null;
  ip: string | null;
  userAgent: string | null;
  platform: string | null;
  browser: string | null;
  trusted: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
}

export function truncateUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown device';
  if (ua.length <= 60) return ua;
  return ua.slice(0, 57) + '…';
}

export function describeDevice(device: Device): string {
  if (device.browser && device.platform) return `${device.browser} on ${device.platform}`;
  return truncateUserAgent(device.userAgent);
}

/**
 * Known devices section of account security settings (#2119).
 * Purely presentational: all state and handlers live in the parent page and
 * are passed in as props (S6478 — no props/state captured from module scope).
 */
export default function DevicesSection({
  devices,
  actionLoading,
  onTrustDevice,
  onRemoveDevice,
}: Readonly<{
  devices: Device[];
  actionLoading: string;
  onTrustDevice: (deviceId: string) => void;
  onRemoveDevice: (deviceId: string) => void;
}>) {
  return (
    <div className="bg-[#0a0a0a] border border-gray-800 rounded-2xl p-8">
      <h2 className="text-lg font-semibold text-white mb-2">Known devices</h2>
      <p className="text-sm text-gray-400 mb-6">Devices that have been used to access your account.</p>

      {devices.length === 0 ? (
        <p className="text-sm text-gray-500">No devices recorded yet.</p>
      ) : (
        <div className="space-y-3">
          {devices.map(device => (
            <div key={device.id} className="flex items-start justify-between p-3 bg-gray-900 rounded-lg border border-gray-800">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm text-white truncate">{describeDevice(device)}</p>
                  {device.trusted && (
                    <span className="px-1.5 py-0.5 text-xs bg-green-900/30 border border-green-800 rounded text-green-400 whitespace-nowrap">Trusted</span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  {device.ip && <span>{device.ip} · </span>}
                  Last seen {new Date(device.lastSeenAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex gap-2 ml-3 flex-shrink-0">
                {!device.trusted && (
                  <button type="button"
                    onClick={() => onTrustDevice(device.id)}
                    disabled={actionLoading === `trust-${device.id}`}
                    className="text-xs px-2 py-1 border border-gray-700 text-gray-400 rounded hover:bg-gray-800 transition disabled:opacity-50"
                  >
                    Trust
                  </button>
                )}
                <button type="button"
                  onClick={() => onRemoveDevice(device.id)}
                  disabled={actionLoading === `device-${device.id}`}
                  className="text-xs px-2 py-1 border border-red-800 text-red-400 rounded hover:bg-red-900/20 transition disabled:opacity-50"
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
