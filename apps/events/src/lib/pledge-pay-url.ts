/** Events calls pay over its public HTTP contract even while deployed from this repository. */
export function serviceUrl(service: 'pay'): string | null {
  const explicit = process.env.PAY_SERVICE_URL;
  if (explicit) return explicit;
  const kernel = process.env.IMAJIN_KERNEL_URL;
  if (!kernel) return null;
  const base = kernel.endsWith('/') ? kernel.slice(0, -1) : kernel;
  return `${base}/${service}`;
}
