# @ima-jin/ui

Shared UI components for Imajin apps — NavBar, identity management, app launcher, theming, and common patterns.

## Install

```bash
npm install @ima-jin/ui
```

## Components

- **NavBar** — Full navigation bar with identity switching, app launcher, notifications, and balance display
- **AppLauncher** — Grid launcher for Imajin services
- **BalanceBadge** — MJNx/cash balance display
- **AppShell** — Layout shell with header, body, footer, and split pane support
- **Button** — Styled button component
- **MarkdownEditor** — MDX editor with toolbar
- **MarkdownContent** — Markdown renderer
- **ConnectionPicker** — DID connection selector
- **ToastProvider / useToast** — Toast notification system
- **NotificationProvider / NotificationBell** — Real-time notifications
- **ActionSheet** — Mobile-friendly bottom sheet
- **MoneyInput** — Currency input with formatting
- **ImajinFooter** — Standard footer
- **BuildInfo** — Version/build info display

## Hooks & Utilities

- `useIdentities()` — Fetch and manage personal + group identities
- `getActingAs() / setActingAs()` — Acting-as DID cookie management
- `themeInitScript` — Dark/light mode initialization

## Part of Imajin

[Imajin](https://imajin.ai) — sovereign technology infrastructure. Open source.
