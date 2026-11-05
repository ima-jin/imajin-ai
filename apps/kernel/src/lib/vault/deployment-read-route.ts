const HEADER = 'x-imajin-deployment-read';
export const isDeploymentReadRequest = (request: Request) => request.headers.has(HEADER);

/** Keep unrelated legacy route imports independent of the reserved delivery consumer. */
export async function deploymentReadRoute(request: Request, action: 'list' | 'fetch' | 'ack', grantId?: string) {
  const delivery = await import('./deployment-read');
  return delivery.deploymentReadRoute(request, action, grantId);
}
