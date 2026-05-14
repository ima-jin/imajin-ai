export { isAllowedOrigin, corsHeaders, corsOptions, withCors, validateOrigin } from "./cors";

export {
  SERVICES,
  SERVICE_NAMES,
  getService,
  getPort,
  getServiceUrl,
  getPublicUrl,
  buildPublicUrl,
  servicesByTier,
  servicesByVisibility,
  buildServiceUrlMap,
} from "./services";
export type {
  ServiceDefinition,
  ServiceTier,
  ServiceVisibility,
  ServiceCategory,
} from "./services";

export {
  SESSION_COOKIE_NAME,
  getSessionCookieName,
  getSessionCookieOptions,
} from "./session";

export { apiFetch, apiUrl } from "./base-path";

export {
  HANDLE_PATTERN,
  HANDLE_INPUT_PATTERN,
  HANDLE_ALLOWED_CHARS,
  HANDLE_ERROR,
  RESERVED_HANDLES,
  isValidHandle,
  isReservedHandle,
  normalizeHandleInput,
} from "./handles";

export {
  // Event routes
  eventPath,
  eventEditPath,
  eventAdminPath,
  eventRegisterPath,
  eventMyTicketsPath,
  eventCheckoutSuccessPath,
  eventsDashboardPath,
  eventsCreatePath,
  eventsCheckoutSuccessPath,
  eventsAdminListPath,
  eventUrl,
  eventEditUrl,
  eventRegisterUrl,
  eventMyTicketsUrl,
  // Profile routes
  profilePath,
  profileEditPath,
  profileLoginPath,
  profileRegisterPath,
  profileUrl,
  // Auth routes
  authLoginPath,
  authRegisterPath,
  authOnboardPath,
  authSettingsPath,
  authSecurityPath,
  authGroupSettingsPath,
  authGroupsPath,
  authNewGroupPath,
  authAgentsPath,
  authAppsPath,
  authAttestationsPath,
  authAuthorizePath,
  authDeveloperAppsPath,
  authDeveloperAppPath,
  authMembersPath,
  authNotificationsPath,
  authStubsPath,
  authNewStubPath,
  // Chat routes
  chatConversationsPath,
  chatConversationPath,
  chatPath,
  // Connections routes
  connectionsPath,
  connectionsInvitePath,
  connectionsPodPath,
  // Pay routes
  payPath,
  payHistoryPath,
  payPayoutsPath,
  payTopupPath,
  payTopupSuccessPath,
  // Media routes
  mediaPath,
  // Learn routes
  learnCoursePath,
  learnCourseLessonPath,
  learnCoursePresentPath,
  learnDashboardPath,
  learnCourseDashboardPath,
  learnCourseStudentsPath,
  learnHandlePath,
  // Coffee routes
  coffeeHandlePath,
  coffeeDashboardPath,
  coffeeEditPath,
  coffeeSuccessPath,
  // Dykil routes
  dykilHandlePath,
  dykilSurveyPath,
  dykilCreatePath,
  dykilDashboardPath,
  dykilResultsPath,
  dykilEmbedPath,
  // Links routes
  linksHandlePath,
  linksDashboardPath,
  linksEditPath,
  // Market routes
  marketListingPath,
  marketListingEditPath,
  marketNewListingPath,
  marketSellerPath,
  marketCheckoutSuccessPath,
  marketDashboardPath,
  marketSettingsPath,
  // Articles
  articlesPath,
  articleAuthorPath,
  articlePath,
  // Kernel / other
  registryPath,
  registryDocsPath,
  buildPath,
  bumpPath,
  bugsPath,
  bugsAdminPath,
  healthPath,
  privacyPath,
  whitepaperPath,
  subscribePath,
  developerGuidePath,
  docsPath,
  projectPath,
  notifyPath,
  notifySettingsPath,
} from "./routes";
