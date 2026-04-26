# DESIGN.md — Imajin Design System

> Sunset on black. Post-BBS, pre-web. The GUI that knows it's infrastructure.

## Brand

- **Name:** Imajin (今人)
- **Pronunciation:** eema-gin
- **Tagline:** The internet that pays you back
- **Philosophy:** Sovereign. Open. Legible. Nothing to hide.

## Color Palette

### Background

The foundation is always dark. Not trendy-dark — *space* dark. The content floats on it.

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-base` | `#0a0a0f` | Page background, app shell |
| `--bg-surface` | `#12121a` | Cards, panels, modals |
| `--bg-elevated` | `#1a1a26` | Hover states, raised elements |
| `--bg-input` | `#15151f` | Form fields, text inputs |

### Sunset Gradient — The Primary Palette

The accent is not one color. It's a gradient — purple through blue through red to orange. Used for brand moments, CTAs, and emphasis. Left-to-right or bottom-to-top.

| Token | Value | Role | Semantic |
|-------|-------|------|----------|
| `--sunset-purple` | `#8b5cf6` | Gradient start | Protocol, network, deep infrastructure |
| `--sunset-blue` | `#6366f1` | Gradient mid-left | Identity, trust, verification |
| `--sunset-red` | `#ef4444` | Gradient mid-right | Settlement, payments, action |
| `--sunset-orange` | `#f97316` | Gradient end | Community, presence, warmth |

**Gradient CSS:**
```css
--sunset-gradient: linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316);
```

### Functional Colors

| Token | Value | Usage |
|-------|-------|-------|
| `--text-primary` | `#f0f0f5` | Primary text |
| `--text-secondary` | `#9393a8` | Secondary text, labels |
| `--text-muted` | `#5a5a72` | Placeholders, disabled |
| `--success` | `#22c55e` | Confirmations, positive states |
| `--warning` | `#eab308` | Warnings, caution |
| `--error` | `#ef4444` | Errors, destructive actions (shares with sunset-red) |
| `--info` | `#6366f1` | Informational (shares with sunset-blue) |

### Interactive States

| State | Primary Button | Secondary Button |
|-------|---------------|-----------------|
| Default | `--sunset-gradient` background, white text | `--bg-elevated` background, `--text-primary` text |
| Hover | Gradient shifts 10% brighter | `--bg-surface` with 1px `--sunset-purple` border |
| Active | Gradient shifts 10% darker | `--bg-base` with 1px `--sunset-blue` border |
| Disabled | 40% opacity, no gradient | 40% opacity |

## Typography

| Role | Font | Weight | Size | Tracking |
|------|------|--------|------|----------|
| Headings | System mono (JetBrains Mono if loaded) | 700 (bold) | 1.5–2.5rem | -0.02em |
| Body | System sans (Inter if loaded) | 400 (regular) | 0.875–1rem | 0 |
| Labels | System mono | 500 (medium) | 0.6875rem | 0.05em (uppercase) |
| Data/Values | System mono | 400 | 0.875rem | 0 |
| Code | System mono | 400 | 0.875rem | 0 |
| Hero/Display | System mono | 700 (bold) | 2.5–4rem | -0.03em |
| Nav items | System mono | 500 (medium) | 0.8125rem | 0.02em |

**Rules:**
- Monospace is a first-class citizen, not just for code. Use it for headings, labels, navigation, data values — anything structural.
- Sans-serif for body text and long-form reading only.
- The mix of mono and sans IS the aesthetic. It says: this is infrastructure you can read.
- Max line length: 65ch for body text.
- Headings: sentence case. Labels: UPPERCASE monospace.
- No font loading required. System stack first, optional enhancement.

## Spacing

Base unit: **4px**. Everything is a multiple.

| Token | Value | Usage |
|-------|-------|-------|
| `--space-1` | 4px | Tight gaps (icon-to-text) |
| `--space-2` | 8px | Inline spacing, small gaps |
| `--space-3` | 12px | Input padding, list items |
| `--space-4` | 16px | Card padding, section gaps |
| `--space-6` | 24px | Between components |
| `--space-8` | 32px | Section separators |
| `--space-12` | 48px | Page sections |
| `--space-16` | 64px | Hero spacing, major sections |

## Border Radius

**None.** Zero. Everywhere.

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-none` | 0 | Everything |

No rounded corners on buttons. No rounded corners on cards. No rounded corners on inputs. No rounded corners on avatars. Rectangles. The grid is visible. The structure is the aesthetic.

The only exception: actual circular indicators (online status dots, notification counts) use `border-radius: 50%`.

## Shadows

**Almost none.** Elevation through borders and background color, not shadows.

| Token | Value | Usage |
|-------|-------|-------|
| `--shadow-glow` | `0 0 20px rgba(139,92,246,0.15)` | Accent glow on focus/active (purple base) |

No drop shadows on cards. No drop shadows on buttons. Depth comes from visible 1px borders and background color steps. The interface is flat and proud of it.

## Components

### Buttons

- **Primary:** Sunset gradient background, white text, **no radius**, monospace font, `--space-2` vertical / `--space-4` horizontal padding.
- **Secondary:** `--bg-elevated`, `--text-primary`, 1px solid `rgba(255,255,255,0.15)` border.
- **Ghost:** Transparent background, `--text-secondary`, hover `--bg-elevated`.
- **Destructive:** `--sunset-red` solid background, white text.
- All buttons: monospace text. The button *looks* like a command.

### Cards / Panels

- Background: `--bg-surface`
- Border: 1px solid `rgba(255,255,255,0.1)` — **visible**. You see the grid.
- Radius: 0
- Padding: `--space-3` to `--space-4`
- No drop shadow. Ever. Hover: border shifts to `rgba(255,255,255,0.2)`.

### Inputs

- Background: `--bg-input`
- Border: 1px solid `rgba(255,255,255,0.12)`
- Focus: border shifts to `--sunset-purple`, subtle glow
- Radius: 0
- Text: `--text-primary`, monospace for data fields, sans for long text inputs
- Placeholder: `--text-muted`

### Navigation

- Background: `--bg-base` with 1px solid `rgba(255,255,255,0.08)` border-bottom
- Active item: `--sunset-gradient` underline (2px, hard edge) or gradient text
- Inactive: `--text-secondary`, monospace
- Items feel like terminal commands, not app tabs

### The Gradient

Use the sunset gradient for:
- Primary CTAs
- Active navigation indicators (hard-edge underlines)
- Brand moments (hero text, section dividers)
- Progress bars and loading states
- Selected/active state borders or underlines

Do NOT use the gradient for:
- Body text
- Backgrounds of large areas (too noisy)
- Every button (only primary)
- Borders on inactive elements (use a single sunset color or white/alpha)

### Density

The interface is **dense**. More information per viewport. Less luxury whitespace. Panels over floating cards. Visible structure over invisible grids. This is a tool that knows it's a tool.

## Tailwind Mapping

```js
// tailwind.config.js theme.extend.colors
{
  imajin: {
    purple: '#8b5cf6',
    blue: '#6366f1',
    red: '#ef4444',
    orange: '#f97316',
  },
  surface: {
    base: '#0a0a0f',
    card: '#12121a',
    elevated: '#1a1a26',
    input: '#15151f',
  }
}
```

```css
/* Utility classes */
.sunset-gradient {
  background: linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316);
}
.sunset-text {
  background: linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
```

## Don'ts

1. **Don't use border-radius.** Zero. On everything. This is the single most important rule. If an agent adds `rounded-lg` to anything, it's wrong.
2. **Don't use orange-on-black as the primary combination.** The old palette. Use the sunset gradient or individual sunset colors on dark backgrounds.
3. **Don't use pure white (`#ffffff`) for text.** Use `--text-primary` (`#f0f0f5`). Pure white is harsh on dark backgrounds.
4. **Don't use light mode as primary.** Dark mode is the identity. Light mode can exist as an option but the brand is sunset-on-dark.
5. **Don't put the gradient on large background areas.** It's an accent, not a wallpaper. Use it for CTAs, indicators, and brand moments.
6. **Don't use more than two sunset colors in the same component.** The gradient is for brand moments. Individual components should pick one or two sunset colors.
7. **Don't use gray-900 for backgrounds.** Use the `surface` tokens. The backgrounds have a subtle blue/purple undertone that separates them from generic dark themes.
8. **Don't hardcode hex values in components.** Use the Tailwind tokens or CSS variables.
9. **Don't use drop shadows.** Elevation is borders and background steps. No `shadow-sm`, no `shadow-md`.
10. **Don't use sans-serif for labels, headings, or navigation.** Monospace for structure, sans for body text only.
11. **Don't add padding luxury.** Dense > spacious. If a card has `p-8`, it's probably `p-3` or `p-4`.
12. **Don't make it look like a SaaS dashboard.** No soft corners, no gentle gradients, no friendly illustrations. This is infrastructure. It looks like infrastructure.

## Migration Notes

The previous palette was single-accent orange (`#f97316`) on black/gray-900 backgrounds. The sunset palette retains orange as the warmest endpoint but introduces purple, blue, and red as first-class accent colors. The gradient replaces solid orange for primary interactive elements.

**What changes:**
- `bg-orange-500` → `sunset-gradient` (for primary buttons/CTAs)
- `bg-orange-500 hover:bg-orange-600` → gradient shift or single sunset color
- `focus:ring-orange-500` → `focus:ring-violet-500` (purple anchors focus states)
- `bg-gray-900` → `bg-[#12121a]` or `bg-surface-card` (warmer dark)
- `bg-black` → `bg-[#0a0a0f]` or `bg-surface-base`
- `rounded-lg`, `rounded-xl`, `rounded-full` → `rounded-none` (or remove entirely)
- `shadow-sm`, `shadow-md` → remove, use border instead
- `font-sans` on headings/labels/nav → `font-mono`
- Scrollbar thumb: `rgba(249,115,22,0.3)` → `rgba(139,92,246,0.3)` (purple)

**What stays:**
- Dark mode default
- System font stack (adding mono as first-class)
- 4px base spacing
- The `--sunset-orange` value is the same as the old `imajin-orange` — it just isn't alone anymore

---

*Sunset on black. The BBS that learned to paint. Infrastructure you can see.*
