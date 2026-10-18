/** Directory/add visibility only — never a public-web serving policy. Client-safe. */
export const APP_VISIBILITIES = ['public', 'unlisted', 'private', 'internal'] as const;
export type AppVisibility = (typeof APP_VISIBILITIES)[number];

export const APP_VISIBILITY_DESCRIPTIONS: Record<AppVisibility, string> = {
  public: 'Listed in the app directory; anyone can add it.',
  unlisted: 'Not listed; people can add it by direct link or invite.',
  private: 'Only the owning identity and its members can see or add it. Members automatically see it when they join and lose it when they leave.',
  internal: 'API-only: no app tile or launcher entry.',
};

export const APP_VISIBILITY_ERROR = `visibility must be one of: ${APP_VISIBILITIES.join(', ')}`;

export function isAppVisibility(value: unknown): value is AppVisibility {
  return typeof value === 'string' && (APP_VISIBILITIES as readonly string[]).includes(value);
}

/** Wider discovery/access discloses an app; narrowing cannot undo that disclosure. */
export function isVisibilityWidening(previous: AppVisibility, next: AppVisibility): boolean {
  const audience: Record<AppVisibility, number> = { internal: 0, private: 1, unlisted: 2, public: 3 };
  return audience[next] > audience[previous];
}
