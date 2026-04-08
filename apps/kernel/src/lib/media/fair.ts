export interface FairTerms {
  license: string;        // e.g. 'CC-BY-4.0', 'all-rights-reserved'
  attribution: string;    // human-readable attribution string
  usage?: string[];       // allowed use cases
}

export interface FairManifestData {
  version: '0.2.0';
  assetId: string;
  creatorDid: string;
  terms: FairTerms;
  metadata?: Record<string, unknown>;
  createdAt: string;      // ISO 8601
}

/**
 * Create a .fair manifest object for an asset.
 */
export function createFairManifest(
  assetId: string,
  creatorDid: string,
  terms: FairTerms,
  metadata?: Record<string, unknown>,
): FairManifestData {
  return {
    version: '0.2.0',
    assetId,
    creatorDid,
    terms,
    metadata,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Serialize a .fair manifest to JSON string.
 */
export function serializeFairManifest(manifest: FairManifestData): string {
  return JSON.stringify(manifest, null, 2);
}
