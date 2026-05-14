/**
 * Centralized public route paths.
 * Every service imports from here — change the prefix once, changes everywhere.
 *
 * Note: These are the *public-facing* URL paths (after any proxy/basePath
 * stripping).  Internal Next.js file paths may differ (e.g. kernel profiles
 * are in `app/profile/p/[handle]` but the public URL is `/p/[handle]`).
 */

// ─── Event routes (events.imajin.ai) ───────────────────────────────────────
export const eventPath = (eventId: string) => `/e/${eventId}`;
export const eventEditPath = (eventId: string) => `/e/${eventId}/edit`;
export const eventRegisterPath = (eventId: string, ticketId: string) =>
  `/e/${eventId}/register/${ticketId}`;
export const eventMyTicketsPath = (eventId: string) => `/e/${eventId}/my-tickets`;
export const eventCheckoutSuccessPath = (eventId: string) =>
  `/e/${eventId}#tickets`;
export const eventAdminPath = (eventId: string) => `/admin/${eventId}`;
export const eventsDashboardPath = () => `/dashboard`;
export const eventsCreatePath = () => `/create`;
export const eventsCheckoutSuccessPath = () => `/checkout/success`;
export const eventsAdminListPath = () => `/admin`;

// Event full URL builders (for cross-service links, emails, etc.)
export const eventUrl = (baseUrl: string, eventId: string) =>
  `${baseUrl}/e/${eventId}`;
export const eventEditUrl = (baseUrl: string, eventId: string) =>
  `${baseUrl}/e/${eventId}/edit`;
export const eventRegisterUrl = (
  baseUrl: string,
  eventId: string,
  ticketId: string
) => `${baseUrl}/e/${eventId}/register/${ticketId}`;
export const eventMyTicketsUrl = (baseUrl: string, eventId: string) =>
  `${baseUrl}/e/${eventId}/my-tickets`;

// ─── Profile routes (profile.imajin.ai) ────────────────────────────────────
export const profilePath = (handle: string) => `/p/${handle}`;
export const profileEditPath = () => `/p/edit`;
export const profileLoginPath = () => `/profile/login`;
export const profileRegisterPath = () => `/profile/register`;

export const profileUrl = (baseUrl: string, handle: string) =>
  `${baseUrl}/p/${handle}`;

// ─── Auth routes (auth.imajin.ai) ──────────────────────────────────────────
export const authLoginPath = () => `/auth/login`;
export const authRegisterPath = () => `/auth/register`;
export const authOnboardPath = () => `/auth/onboard`;
export const authSettingsPath = () => `/auth/settings`;
export const authSecurityPath = () => `/auth/settings/security`;
export const authGroupSettingsPath = (groupDid: string) =>
  `/auth/groups/${groupDid}/settings`;
export const authGroupsPath = () => `/auth/groups`;
export const authNewGroupPath = () => `/auth/groups/new`;
export const authAgentsPath = () => `/auth/agents`;
export const authAppsPath = () => `/auth/apps`;
export const authAttestationsPath = () => `/auth/attestations`;
export const authAuthorizePath = () => `/auth/authorize`;
export const authDeveloperAppsPath = () => `/auth/developer/apps`;
export const authDeveloperAppPath = (appId: string) =>
  `/auth/developer/apps/${appId}`;
export const authMembersPath = () => `/auth/members`;
export const authNotificationsPath = () => `/auth/notifications`;
export const authStubsPath = (did: string) => `/auth/stubs/${did}`;
export const authNewStubPath = () => `/auth/stubs/new`;

// ─── Chat routes (chat.imajin.ai) ──────────────────────────────────────────
export const chatConversationsPath = () => `/chat/conversations`;
export const chatConversationPath = (type: string, slug: string) =>
  `/chat/conversations/${type}/${slug}`;
export const chatPath = () => `/chat`;

// ─── Connections routes (connections.imajin.ai) ────────────────────────────
export const connectionsPath = () => `/connections`;
export const connectionsInvitePath = (did: string, code: string) =>
  `/connections/invite/${did}/${code}`;
export const connectionsPodPath = (id: string) => `/connections/pods/${id}`;

// ─── Pay routes (pay.imajin.ai) ────────────────────────────────────────────
export const payPath = () => `/pay`;
export const payHistoryPath = () => `/pay/history`;
export const payPayoutsPath = () => `/pay/payouts`;
export const payTopupPath = () => `/pay/topup`;
export const payTopupSuccessPath = () => `/pay/topup/success`;

// ─── Media routes (media.imajin.ai) ────────────────────────────────────────
export const mediaPath = () => `/media`;

// ─── Learn routes (learn.imajin.ai) ────────────────────────────────────────
export const learnCoursePath = (slug: string) => `/course/${slug}`;
export const learnCourseLessonPath = (slug: string, lessonId: string) =>
  `/course/${slug}/${lessonId}`;
export const learnCoursePresentPath = (slug: string) => `/course/${slug}/present`;
export const learnDashboardPath = () => `/dashboard`;
export const learnCourseDashboardPath = (slug: string) => `/dashboard/${slug}`;
export const learnCourseStudentsPath = (slug: string) =>
  `/dashboard/${slug}/students`;
export const learnHandlePath = (handle: string) => `/${handle}`;

// ─── Coffee routes (coffee.imajin.ai) ──────────────────────────────────────
export const coffeeHandlePath = (handle: string) => `/${handle}`;
export const coffeeDashboardPath = () => `/dashboard`;
export const coffeeEditPath = () => `/edit`;
export const coffeeSuccessPath = () => `/success`;

// ─── Dykil routes (dykil.imajin.ai) ────────────────────────────────────────
export const dykilHandlePath = (handle: string) => `/${handle}`;
export const dykilSurveyPath = (handle: string, surveyId: string) =>
  `/${handle}/${surveyId}`;
export const dykilCreatePath = () => `/create`;
export const dykilDashboardPath = () => `/dashboard`;
export const dykilResultsPath = (id: string) => `/survey/${id}/results`;
export const dykilEmbedPath = (surveyId: string) => `/embed/${surveyId}`;

// ─── Links routes (links.imajin.ai) ────────────────────────────────────────
export const linksHandlePath = (handle: string) => `/${handle}`;
export const linksDashboardPath = () => `/dashboard`;
export const linksEditPath = () => `/edit`;

// ─── Market routes (market.imajin.ai) ──────────────────────────────────────
export const marketListingPath = (id: string) => `/listings/${id}`;
export const marketListingEditPath = (id: string) => `/listings/${id}/edit`;
export const marketNewListingPath = () => `/listings/new`;
export const marketSellerPath = (handle: string) => `/seller/${handle}`;
export const marketCheckoutSuccessPath = () => `/checkout/success`;
export const marketDashboardPath = () => `/dashboard`;
export const marketSettingsPath = () => `/settings`;

// ─── Kernel / articles ─────────────────────────────────────────────────────
export const articlesPath = () => `/articles`;
export const articleAuthorPath = (handle: string) => `/articles/${handle}`;
export const articlePath = (handle: string, slug: string) =>
  `/articles/${handle}/${slug}`;

// ─── Kernel / other ────────────────────────────────────────────────────────
export const registryPath = () => `/registry`;
export const registryDocsPath = () => `/registry/docs`;
export const buildPath = () => `/build`;
export const bumpPath = () => `/bump`;
export const bugsPath = () => `/bugs`;
export const bugsAdminPath = () => `/bugs/admin`;
export const healthPath = () => `/health`;
export const privacyPath = () => `/privacy`;
export const whitepaperPath = () => `/whitepaper`;
export const subscribePath = () => `/subscribe`;
export const developerGuidePath = () => `/developer-guide`;
export const docsPath = () => `/docs`;
export const projectPath = () => `/project`;
export const notifyPath = () => `/notify`;
export const notifySettingsPath = () => `/notify/settings`;
