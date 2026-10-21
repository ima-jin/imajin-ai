/** Shared by the App secrets link and the existing provision row control. */
export function provisionReissueAnchorId(slug: string): string {
  return `provision-reissue-${encodeURIComponent(slug)}`;
}
