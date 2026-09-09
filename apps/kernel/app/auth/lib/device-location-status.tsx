/**
 * Device-location status indicator shown next to a "Location" field label
 * (create-identity, add-a-place, and edit-place forms). Extracted so the
 * three near-identical copies don't count as new-code duplication (#2070).
 */
export interface DeviceLocationLike {
  lat: number;
  lon: number;
  accuracy: number;
}

export function DeviceLocationStatus({ deviceLoc, deviceLocError }: Readonly<{
  deviceLoc: DeviceLocationLike | null;
  deviceLocError: string | null;
}>) {
  if (deviceLoc) {
    return (
      <span className="text-[10px] text-zinc-500 font-mono tabular-nums">
        📍 {deviceLoc.lat.toFixed(4)}, {deviceLoc.lon.toFixed(4)}
        <span className="text-zinc-600 ml-1">(±{Math.round(deviceLoc.accuracy)}m)</span>
      </span>
    );
  }
  if (deviceLocError) {
    return <span className="text-[10px] text-zinc-600">{deviceLocError}</span>;
  }
  return <span className="text-[10px] text-zinc-600">Locating…</span>;
}
