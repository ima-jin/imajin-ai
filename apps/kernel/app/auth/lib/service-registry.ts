/** Build a registry app dashboard iframe URL for the effective identity. */
export function buildEmbedSrc(did: string, baseUrl: string): string {
  return `${baseUrl}/dashboard?embed=hub&did=${encodeURIComponent(did)}`;
}
