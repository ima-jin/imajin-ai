// Keep this browser module independent of server auth, crypto, and vault code.
export const PUBLIC_KEY = /^[0-9a-fA-F]{64}$/;
const KID = /^auth-[0-9a-f]{16}$/;
const SIGNATURE = /^[0-9a-fA-F]{128}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const PAYLOAD_FIELDS = [
  'oldKid', 'newKid', 'oldPublicKey', 'newPublicKey',
  'effectiveAt', 'oldKeySignature', 'newKeySignature',
] as const;

export type PublicPayload = Record<typeof PAYLOAD_FIELDS[number], string>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid response');
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid count');
  return value;
}

function publicKey(value: unknown): string {
  if (typeof value !== 'string' || !PUBLIC_KEY.test(value)) throw new Error('Invalid public key');
  return value;
}

/** Reject extra fields rather than forwarding a file that might contain private material. */
export function parsePublicPayload(value: unknown): PublicPayload {
  const input = record(value);
  if (Object.keys(input).length !== PAYLOAD_FIELDS.length) throw new Error('Invalid payload');
  const output = {} as PublicPayload;
  for (const key of PAYLOAD_FIELDS) {
    if (typeof input[key] !== 'string') throw new Error('Invalid payload');
    output[key] = input[key] as string;
  }
  if (!KID.test(output.oldKid) || !KID.test(output.newKid)
    || !PUBLIC_KEY.test(output.oldPublicKey) || !PUBLIC_KEY.test(output.newPublicKey)
    || output.oldPublicKey.toLowerCase() === output.newPublicKey.toLowerCase()
    || !SIGNATURE.test(output.oldKeySignature) || !SIGNATURE.test(output.newKeySignature)
    || !INSTANT.test(output.effectiveAt) || !Number.isFinite(Date.parse(output.effectiveAt))) {
    throw new Error('Invalid payload');
  }
  return output;
}

export type Handoff = { pending: false } | { pending: true; exported: number; newPublicKey: string };

/** Whitelist values as well as names. Never render API errors or arbitrary response text. */
export function parseHandoff(value: unknown): Handoff {
  const input = record(value);
  if (input.pending === false) return { pending: false };
  if (input.pending !== true) throw new Error('Invalid status');
  return { pending: true, exported: count(input.exported), newPublicKey: publicKey(input.newPublicKey) };
}

export function parseExport(value: unknown, expectedKey: string): Handoff {
  const input = record(value);
  const key = publicKey(input.newPublicKey);
  if (key.toLowerCase() !== expectedKey.toLowerCase()) throw new Error('Unexpected public key');
  return { pending: true, exported: count(input.exported), newPublicKey: key };
}

export function parseResealed(value: unknown): number {
  return count(record(value).resealed);
}
export function parseCustody(value: unknown) {
  const input = record(value);
  if (typeof input.aborted !== 'boolean') throw new Error('Invalid custody verdict');
  return { totalV1Fields: count(input.totalV1Fields), candidateCount: count(input.candidateCount), aborted: input.aborted };
}

export function parseVerification(value: unknown) {
  const input = record(value);
  if (typeof input.ok !== 'boolean') throw new Error('Invalid verdict');
  const currentKid = input.currentKid;
  if (currentKid !== null && (typeof currentKid !== 'string' || !KID.test(currentKid))) {
    throw new Error('Invalid key identifier');
  }
  const { nodeDid, nodeDidSource, processStartedAt } = input;
  if (nodeDid !== null && (typeof nodeDid !== 'string' || !/^did:imajin:[\w.:-]{1,200}$/.test(nodeDid))) {
    throw new Error('Invalid public node DID');
  }
  if (!['relay_config', 'RELAY_DID', 'none'].includes(String(nodeDidSource)) ||
    typeof processStartedAt !== 'string' || !INSTANT.test(processStartedAt) ||
    !Number.isFinite(Date.parse(processStartedAt))) throw new Error('Invalid process metadata');
  return {
    ok: input.ok, rotations: count(input.rotations), currentKid: currentKid as string | null,
    nodeDid: nodeDid as string | null, nodeDidSource: nodeDidSource as string, processStartedAt,
  };
}

export function parseRecorded(value: unknown): void {
  const input = record(value);
  if (typeof input.attestationId !== 'string' || !input.attestationId
    || typeof input.oldKid !== 'string' || !KID.test(input.oldKid)
    || typeof input.newKid !== 'string' || !KID.test(input.newKid)
    || typeof input.effectiveAt !== 'string' || !INSTANT.test(input.effectiveAt)) {
    throw new Error('Invalid attestation receipt');
  }
  // The receipt is deliberately not displayed; the verifier is the source of truth.
}
