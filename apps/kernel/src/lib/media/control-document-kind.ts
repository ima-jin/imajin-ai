/** Only routing metadata is stored in the asset row, never released legal values. */
export function isLegalEntityAsset(metadata: unknown): boolean {
  return (metadata as { kind?: unknown } | null)?.kind === 'legal-entity';
}
