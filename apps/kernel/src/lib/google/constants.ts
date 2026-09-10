/**
 * Google Workspace connector constants (leaf module — mirrors github/constants.ts, #1373).
 *
 * Holds identifiers shared across the connector, its scope-manifest wrapper,
 * and the route factories. Kept dependency-free so importing it never pulls
 * in the connector's DB/OAuth/vault graph.
 */

/** Connector app DID — matches the scope-manifest entries for the `google` connector. */
export const GOOGLE_CONNECTOR_DID = 'did:imajin:google-connector';
