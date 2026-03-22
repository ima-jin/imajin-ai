import * as dagCbor from '@ipld/dag-cbor';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';

/**
 * Compute a CIDv1 (dag-cbor + SHA-256) for any JSON-serializable object.
 *
 * The object is canonically encoded as dag-cbor, then SHA-256 hashed,
 * producing a deterministic CID string identical to what DFOS uses.
 *
 * @returns CID as base32lower string (bafyrei...)
 */
export async function computeCid(object: unknown): Promise<string> {
  const encoded = dagCbor.encode(object);
  const hash = await sha256.digest(encoded);
  const cid = CID.createV1(dagCbor.code, hash);
  return cid.toString(); // base32lower by default
}

/**
 * Verify that an object matches an expected CID.
 *
 * @returns true if the recomputed CID matches
 */
export async function verifyCid(object: unknown, expectedCid: string): Promise<boolean> {
  const actual = await computeCid(object);
  return actual === expectedCid;
}

/**
 * Parse a CID string back into a CID object.
 * Useful for inspecting codec, hash, version.
 */
export function parseCid(cidString: string): CID {
  return CID.parse(cidString);
}
