# Standalone Dashboards → Hub Tabs (#2275)

The hub (`jin.imajin.ai/auth/<service>`) now embeds each userspace service's
dashboard in an iframe via `<ServiceEmbed>` (`?embed=hub&did=...`, #800 /
#2275). Every service still also serves its own full-page, standalone
dashboard at its pre-hub URL — that page is what this document plans to
retire.

**Status: implemented (#2332).** Each app below redirects its standalone
`/dashboard` route to the hub tab via a per-app `middleware.ts`. The redirect
is unconditional (a plain 308, query string preserved) — the middleware
matcher itself excludes the embedded rendering path (`?embed=hub`, see
"Mechanism" below), so there is no runtime branch on that query param or on a
hub session. The hub URL is built from `buildPublicUrlAbsolute('kernel')` +
`/auth/<service>` (`@imajin/config`), never a hard-coded domain, so dev and
prod both resolve correctly. The standalone `/dashboard` pages themselves
stay in place behind the redirect.

## Why this waited

When the embed shipped (#2275), the standalone dashboards were kept as the
only entry point for anyone who'd bookmarked them, and as a fallback for
debugging the embedded rendering (`?embed=hub`) before it had a release cycle
to prove out. That release cycle has now passed, so #2332 turns the map below
into real redirects.

## Mechanism (#2332)

Each app in the redirect map ships (or, if it already had one, extends) its
own `middleware.ts`:

- The redirect is **unconditional** — a plain `NextResponse.redirect(hubUrl,
  308)` on the standalone `/dashboard` path, no `?embed=hub` check or hub-
  session check in the handler itself, and the original query string is
  preserved on the hub URL.
- The embedded rendering path (`?embed=hub&did=...`, what `<ServiceEmbed>`
  fetches — see `apps/kernel/app/auth/lib/service-registry.ts`'s
  `buildEmbedSrc`) is excluded declaratively via the middleware `matcher`'s
  `missing: [{ type: 'query', key: 'embed' }]`, not a runtime branch: a
  request carrying `embed` never reaches the redirect handler at all.
- The hub URL is built from `buildPublicUrlAbsolute('kernel')` (from
  `@imajin/config`) + `/auth/<service>` — never a hard-coded domain — so both
  dev (`http://localhost:<port>`) and prod (`https://jin.imajin.ai`) resolve
  correctly.
- The standalone `/dashboard` pages themselves are unchanged and stay behind
  the redirect for now (see "Out of scope" on the tracking issue).

## Redirect map

| Standalone route | Hub route | Notes |
|---|---|---|
| `jin.imajin.ai/events/dashboard` | `jin.imajin.ai/auth/events` | |
| `jin.imajin.ai/coffee/dashboard` | `jin.imajin.ai/auth/coffee` | |
| `jin.imajin.ai/market/dashboard` | `jin.imajin.ai/auth/market` | |
| `jin.imajin.ai/dykil/dashboard` | `jin.imajin.ai/auth/dykil` | route group `(chrome)/dashboard` |
| `jin.imajin.ai/learn/dashboard` | `jin.imajin.ai/auth/learn` | |
| `jin.imajin.ai/links/dashboard` | `jin.imajin.ai/auth/links` | |

Each standalone app's public/browse pages (`/`, listing pages, course pages,
etc.) are **not** part of this map — those stay as-is; only the
authenticated *dashboard* surface is superseded by the hub tab.

`pay` and `media` are kernel-native services (served by `apps/kernel` itself
at `/pay` and `/media`, not a separate deploy) — there is no separate
standalone dashboard for either to deprecate.

Any nested dashboard sub-route not listed above (e.g.
`/market/dashboard/listings/123`) has no hub equivalent yet — the hub only
ever lands on each service's top-level embed. `ServiceEmbed` does relay a
RFC-19 `navigate` message from the embedded app to update the visible hub URL
to `/auth/<service><path>` (shallow, via `history.replaceState`), but that's a
cosmetic address-bar update, not a route that a fresh page load can resolve.
Mapping every nested standalone sub-route to a real hub route is out of scope
here.

## Follow-up

Mapping nested standalone sub-routes (e.g. `/market/dashboard/listings/123`)
to real hub routes, and retiring the standalone `/dashboard` pages
themselves, remain out of scope and untracked as of #2332.
