import { roundTrip } from './round-trip.test.ts';

const output = document.querySelector('pre')!;
const results = [];
for (const [library, run] of [
  ['ts-mls', roundTrip],
  ['openmls', async () => {
    const wasm = await import('../openmls/pkg/pq_mls_openmls_spike.js');
    await wasm.default();
    return JSON.parse(wasm.round_trip());
  }],
] as const) {
  try {
    results.push({ library, status: 'PASS', result: await run() });
  } catch (error) {
    results.push({ library, status: 'FAIL', error: String(error) });
  }
}
output.textContent = JSON.stringify({ runtime: navigator.userAgent, results }, null, 2);
document.title = results.every(r => r.status === 'PASS') ? 'PQ-MLS PASS' : 'PQ-MLS FAIL';
