import {
  PURPOSE, REPOSITORY, type DeliveryBinding,
} from '../../../../../deploy/infer-passthrough/deployment-read-protocol.mjs';

export { PURPOSE as DEPLOYMENT_READ_PURPOSE };
export interface DeploymentReadImport { repository: string; recipientDid: string }
const DID = /^did:[a-z0-9]+:[A-Za-z0-9._%-]+$/;

/** Existing /jin import fields suffice; the repository is server-selected, never guessed by an agent. */
export function normalizeDeploymentReadImport(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const body = raw as Record<string, unknown>;
  if (body.purpose !== PURPOSE || body.deploymentRead !== undefined) return raw;
  return { ...body, deploymentRead: { repository: REPOSITORY, recipientDid: body.consumerDid } };
}

/** Public policy only. Absence fails closed; there is no default recipient or owner. */
export function deploymentReadBinding(): DeliveryBinding & { publicKey: string } {
  const ownerDid = process.env.INFER_DEPLOY_READ_OWNER_DID;
  const recipientDid = process.env.INFER_DEPLOY_READ_RECIPIENT_DID;
  const publicKey = process.env.INFER_DEPLOY_READ_RECIPIENT_PUBLIC_KEY;
  if (!ownerDid || !DID.test(ownerDid) || !publicKey || !/^[a-f0-9]{64}$/.test(publicKey)
    || recipientDid !== `did:imajin:${publicKey.slice(0, 16)}`) throw new Error('Deployment policy unavailable');
  return { repository: REPOSITORY, ownerDid, recipientDid, publicKey };
}

export function validDeploymentReadMetadata(raw: Record<string, unknown>): boolean {
  if (raw.deploymentRead === undefined) return raw.purpose !== PURPOSE;
  const binding = raw.deploymentRead as DeploymentReadImport;
  return !!binding && typeof binding === 'object' && !Array.isArray(binding)
    && Object.keys(binding).length === 2 && binding.repository === REPOSITORY
    && typeof binding.recipientDid === 'string'
    && raw.purpose === PURPOSE && raw.consumerDid === binding.recipientDid
    && typeof raw.expiresAt === 'string' && Number.isFinite(Date.parse(raw.expiresAt))
    && raw.cloudflare === undefined;
}

/** Rechecked at proposal, approval execution, discovery and every delivery. */
export function requireDeploymentReadBinding(raw: Record<string, unknown>): void {
  if (raw.deploymentRead === undefined && raw.purpose !== PURPOSE) return;
  const policy = deploymentReadBinding();
  const binding = raw.deploymentRead as DeploymentReadImport;
  if (!validDeploymentReadMetadata(raw) || raw.ownerDid !== policy.ownerDid
    || raw.consumerDid !== policy.recipientDid || binding?.repository !== policy.repository
    || Date.parse(raw.expiresAt as string) <= Date.now()) throw new Error('Deployment authority unavailable');
}
