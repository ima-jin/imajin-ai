/**
 * Human-facing product display name.
 *
 * This is the ONLY place the "(α)" (alpha) stage marker lives — flip it here
 * (e.g. to "(β)" or drop it for GA) and every consumer (BuildInfo, nav bars,
 * page titles/metadata, auth screens, email templates, etc.) picks it up.
 *
 * Do NOT use this for DIDs, URLs, package names, event names, localStorage
 * keys, env vars, or any other code identifier — those stay as literal
 * 'imajin' strings. This constant is display-text only.
 */
export const APP_DISPLAY_NAME = "imajin (α)";
