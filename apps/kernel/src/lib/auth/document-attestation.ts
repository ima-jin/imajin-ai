import { publish } from '@imajin/bus';
import type { Logger } from '@imajin/logger';
import { db, assets, identities, attestationSignatures, type NewAttestationSignature } from '@/src/db';
import { eq } from 'drizzle-orm';
import { verifyDocumentSignatureToken } from '@/src/lib/auth/document-signatures';

interface ValidationFailure {
  status: number;
  error: string;
}

interface CallerIdentity {
  publicKey: string;
  name: string | null;
  handle: string | null;
}

interface DocumentRequestInput {
  title: string;
  documentAssetId: string;
  documentHash: string;
  signerDids: string[];
  payload: Record<string, unknown> | undefined;
  authorJws: string;
  expiry: string | undefined;
  callerIdentity: CallerIdentity;
}

type DocumentBodyParseResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; failure: ValidationFailure };

type DocumentValidationResult =
  | { ok: true; input: DocumentRequestInput }
  | { ok: false; failure: ValidationFailure };

type LoggerLike = Pick<Logger, 'error'>;

export async function parseDocumentRequestBody(request: Request): Promise<DocumentBodyParseResult> {
  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return { ok: false, failure: { status: 400, error: 'Invalid JSON' } };
    }
    return { ok: true, body: body as Record<string, unknown> };
  } catch {
    return { ok: false, failure: { status: 400, error: 'Invalid JSON' } };
  }
}

interface RequiredDocumentFields {
  title: string;
  documentAssetId: string;
  documentHash: string;
  signerDids: string[];
  authorJws: string;
}

type RequiredFieldsResult =
  | { ok: true; fields: RequiredDocumentFields }
  | { ok: false; failure: ValidationFailure };

type AssetOwnershipResult =
  | { ok: true; asset: { ownerDid: string; hash: string } }
  | { ok: false; failure: ValidationFailure };

type CallerIdentityResult =
  | { ok: true; callerIdentity: CallerIdentity }
  | { ok: false; failure: ValidationFailure };

function parseRequiredDocumentFields(body: Record<string, unknown>): RequiredFieldsResult {
  const title = typeof body.title === 'string' ? body.title : '';
  if (!title.trim()) {
    return { ok: false, failure: { status: 400, error: 'title required' } };
  }

  const documentAssetId = typeof body.document_asset_id === 'string' ? body.document_asset_id : '';
  if (!documentAssetId) {
    return { ok: false, failure: { status: 400, error: 'document_asset_id required' } };
  }

  const documentHash = typeof body.document_hash === 'string' ? body.document_hash : '';
  if (!documentHash) {
    return { ok: false, failure: { status: 400, error: 'document_hash required' } };
  }

  const signers = body.signers;
  if (!Array.isArray(signers) || signers.length === 0) {
    return { ok: false, failure: { status: 400, error: 'signers array required (at least 1)' } };
  }

  const authorJws = typeof body.author_jws === 'string' ? body.author_jws : '';
  if (!authorJws) {
    return { ok: false, failure: { status: 400, error: 'author_jws required' } };
  }

  const signerDids = signers.filter((s): s is string => typeof s === 'string' && s.startsWith('did:'));
  if (signerDids.length !== signers.length) {
    return { ok: false, failure: { status: 400, error: 'All signers must be valid DIDs' } };
  }

  return { ok: true, fields: { title, documentAssetId, documentHash, signerDids, authorJws } };
}

async function validateAssetOwnership(
  documentAssetId: string,
  documentHash: string,
  callerDid: string,
): Promise<AssetOwnershipResult> {
  const [asset] = await db
    .select()
    .from(assets)
    .where(eq(assets.id, documentAssetId))
    .limit(1);

  if (!asset) {
    return { ok: false, failure: { status: 404, error: 'Document asset not found' } };
  }
  if (asset.ownerDid !== callerDid) {
    return { ok: false, failure: { status: 403, error: 'You do not own this document' } };
  }
  if (asset.hash !== documentHash) {
    return { ok: false, failure: { status: 400, error: 'Document hash mismatch' } };
  }

  return { ok: true, asset };
}

async function loadCallerIdentityForDocument(callerDid: string): Promise<CallerIdentityResult> {
  const [callerIdentity] = await db
    .select({ publicKey: identities.publicKey, name: identities.name, handle: identities.handle })
    .from(identities)
    .where(eq(identities.id, callerDid))
    .limit(1);

  if (!callerIdentity) {
    return { ok: false, failure: { status: 400, error: 'Caller identity not found' } };
  }

  return { ok: true, callerIdentity };
}

async function verifyAuthorJwsSignature(params: {
  authorJws: string;
  callerIdentity: CallerIdentity;
  callerDid: string;
  documentHash: string;
}): Promise<ValidationFailure | null> {
  const { authorJws, callerIdentity, callerDid, documentHash } = params;
  const signatureValid = await verifyDocumentSignatureToken({
    token: authorJws,
    signerPublicKeyHex: callerIdentity.publicKey,
    signerDid: callerDid,
    documentHash,
  });
  if (!signatureValid) {
    return { status: 400, error: 'Invalid author JWS signature' };
  }
  return null;
}

function parseOptionalDocumentPayload(body: Record<string, unknown>): Record<string, unknown> | undefined {
  return body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
    ? (body.payload as Record<string, unknown>)
    : undefined;
}

export async function validateDocumentRequestInput(params: {
  body: Record<string, unknown>;
  callerDid: string;
}): Promise<DocumentValidationResult> {
  const { body, callerDid } = params;

  const fieldsResult = parseRequiredDocumentFields(body);
  if (!fieldsResult.ok) return fieldsResult;
  const { title, documentAssetId, documentHash, signerDids, authorJws } = fieldsResult.fields;

  const ownershipResult = await validateAssetOwnership(documentAssetId, documentHash, callerDid);
  if (!ownershipResult.ok) return ownershipResult;

  const identityResult = await loadCallerIdentityForDocument(callerDid);
  if (!identityResult.ok) return identityResult;
  const { callerIdentity } = identityResult;

  const signatureFailure = await verifyAuthorJwsSignature({ authorJws, callerIdentity, callerDid, documentHash });
  if (signatureFailure) {
    return { ok: false, failure: signatureFailure };
  }

  return {
    ok: true,
    input: {
      title,
      documentAssetId,
      documentHash,
      signerDids,
      payload: parseOptionalDocumentPayload(body),
      authorJws,
      expiry: typeof body.expiry === 'string' ? body.expiry : undefined,
      callerIdentity,
    },
  };
}

export function buildDocumentSignatureRows(params: {
  attestationId: string;
  creatorDid: string;
  creatorJws: string;
  signerDids: string[];
  genId: (prefix: string) => string;
}): NewAttestationSignature[] {
  const { attestationId, creatorDid, creatorJws, signerDids, genId } = params;
  const now = new Date();

  return [
    {
      id: genId('sig'),
      attestationId,
      signerDid: creatorDid,
      jws: creatorJws,
      signedAt: now,
      status: 'signed',
      role: 'creator',
    },
    ...signerDids.map((did) => ({
      id: genId('sig'),
      attestationId,
      signerDid: did,
      jws: null,
      signedAt: null,
      status: 'pending',
      role: 'signer',
    })),
  ];
}

export function getCreatorDisplayName(callerIdentity: CallerIdentity, callerDid: string): string {
  return callerIdentity.handle ? `@${callerIdentity.handle}` : callerIdentity.name || callerDid;
}

export interface SignatureCounts {
  signed: number;
  declined: number;
  pending: number;
}

/**
 * Build a per-attestation signature status count map (signed/declined/pending)
 * from the flat grouped-count rows returned by the signatures query. Every
 * attestation in `attestationIds` gets an entry, defaulting all counts to 0.
 */
export function buildSignatureCountMap(
  attestationIds: string[],
  sigCounts: Array<{ attestationId: string; status: string; count: number }>,
): Map<string, SignatureCounts> {
  const countMap = new Map<string, SignatureCounts>();
  for (const id of attestationIds) {
    countMap.set(id, { signed: 0, declined: 0, pending: 0 });
  }

  const STATUS_KEYS = new Set(['signed', 'declined', 'pending']);
  for (const sc of sigCounts) {
    const existing = countMap.get(sc.attestationId);
    if (existing && STATUS_KEYS.has(sc.status)) {
      existing[sc.status as keyof SignatureCounts] = sc.count;
    }
  }

  return countMap;
}

export function publishDocumentCreatedNotifications(params: {
  attestationId: string;
  documentAssetId: string;
  creatorDid: string;
  creatorName: string;
  signerDids: string[];
  title: string;
  log: LoggerLike;
}): void {
  const { attestationId, documentAssetId, creatorDid, creatorName, signerDids, title, log } = params;
  const signUrl = `/auth/documents/${attestationId}`;

  for (const signerDid of signerDids) {
    publish('document.created', {
      issuer: creatorDid,
      subject: signerDid,
      scope: 'auth',
      payload: {
        attestationId,
        documentAssetId,
        creatorDid,
        creatorName,
        signerDids,
        title: title.trim(),
        signUrl,
        context_id: attestationId,
        context_type: 'document',
      },
    }).catch((err) => log.error({ err: String(err), signerDid, attestationId }, 'document.created publish failed'));
  }
}

export async function finalizeDocumentAttestation(params: {
  attestationId: string;
  documentAssetId: string;
  creatorDid: string;
  creatorJws: string;
  signerDids: string[];
  title: string;
  callerIdentity: CallerIdentity;
  genId: (prefix: string) => string;
  log: LoggerLike;
}) {
  const {
    attestationId,
    documentAssetId,
    creatorDid,
    creatorJws,
    signerDids,
    title,
    callerIdentity,
    genId,
    log,
  } = params;

  const sigRows = buildDocumentSignatureRows({
    attestationId,
    creatorDid,
    creatorJws,
    signerDids,
    genId,
  });
  await db.insert(attestationSignatures).values(sigRows);
  await db.update(assets).set({ immutable: true }).where(eq(assets.id, documentAssetId));

  const creatorName = getCreatorDisplayName(callerIdentity, creatorDid);
  publishDocumentCreatedNotifications({
    attestationId,
    documentAssetId,
    creatorDid,
    creatorName,
    signerDids,
    title,
    log,
  });

  return db
    .select()
    .from(attestationSignatures)
    .where(eq(attestationSignatures.attestationId, attestationId));
}
