# Standalone Dashboards → Hub Tabs (#2275)

The hub (`jin.imajin.ai/auth/<service>`) now embeds each userspace service's
dashboard in an iframe via `<ServiceEmbed>` (`?embed=hub&did=...`, #800 /
#2275). Every service still also serves its own full-page, standalone
dashboard at its pre-hub URL — that page is what this document plans to
retire.

**This is a map only.** No redirects are implemented by this change; see
"Follow-up" below.

## Why not just redirect now

- The standalone dashboards are the only entry point for anyone who bookmarked
  them, and for any service that hasn't yet verified its embedded rendering
  (`?embed=hub`) looks right inside the hub's iframe chrome — none of the
  userspace apps currently branch on that query param today (they render
  identical chrome standalone or embedded).
- A hard redirect the day the embed ships would remove the fallback exactly
  when it's most useful for debugging.

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

Implementing the actual redirects (e.g. a `middleware.ts` rule per app, or
each standalone `/dashboard` page issuing a `redirect()` to the hub) is
tracked in [#2332](https://github.com/ima-jin/imajin-ai/issues/2332), to be
picked up once the embedded experience has had a release cycle to prove out.
