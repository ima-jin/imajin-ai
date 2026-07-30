/**
 * GitHub connector constants (leaf module \u2014 #1373).
 *
 * Holds identifiers shared across the connector, its scope-manifest wrapper, and
 * the allowlist reader. Kept dependency-free so importing it never pulls the
 * connector's DB/OAuth graph. This is what breaks the import cycle
 * connector \u2192 allowlist \u2192 scope-manifest \u2192 connector (which manifested as a
 * `Cannot access '\u2026' before initialization` TDZ error during `next build`).
 */

/** Connector app DID \u2014 matches the scope-manifest fixture (github-scope-manifest.md). */
export const GITHUB_CONNECTOR_DID = 'did:imajin:github-connector';
