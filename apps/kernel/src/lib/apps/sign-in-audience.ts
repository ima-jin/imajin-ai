/** Sign-in eligibility, independent of directory visibility. Client-safe. */
export const APP_SIGN_IN_AUDIENCES = ['members', 'anyone'] as const;
export type AppSignInAudience = (typeof APP_SIGN_IN_AUDIENCES)[number];

export const APP_SIGN_IN_AUDIENCE_DESCRIPTIONS: Record<AppSignInAudience, string> = {
  members: 'Private apps accept sign-in only from the owner and current members.',
  anyone: 'Any authenticated person may consent by direct link, even when the app is private.',
};
export const APP_SIGN_IN_AUDIENCE_ERROR = `signInAudience must be one of: ${APP_SIGN_IN_AUDIENCES.join(', ')}`;

export function isAppSignInAudience(value: unknown): value is AppSignInAudience {
  return typeof value === 'string' && (APP_SIGN_IN_AUDIENCES as readonly string[]).includes(value);
}
