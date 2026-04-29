# @imajin/tokens

Imajin design tokens — DTCG-format JSON, Style Dictionary build, generated
CSS variables and Tailwind theme.

## Two tiers

### Raw tokens
The literal values. Brand colors, spacing units, font stacks. **Use only
inside `packages/ui` primitives** — never reference these from app code.

```
imajin-purple   #8b5cf6
imajin-orange   #f97316
surface-base    #0a0a0f
surface-input   #15151f
```

### Semantic tokens
Role-based aliases over the raw tier. **App code and `packages/ui` primitives
reference these.** If you change the brand from orange to teal tomorrow, you
edit `semantic.accent` in `tokens.json` — not 200 components.

| Token | Maps to | When to use |
|---|---|---|
| `bg-accent` | sunset orange | Single-color brand accent (badges, tags, decorative) |
| `bg-cta-primary` | sunset gradient | Primary CTA background |
| `bg-cta-secondary` | elevated surface | Secondary/quiet button background |
| `bg-surface-1` | page bg | Outermost app shell |
| `bg-surface-2` | card bg | Cards, panels, modals |
| `bg-surface-3` | raised | Hover states, dropdowns |
| `bg-surface-input` | input bg | Form fields |
| `text-text-heading` | bright | Primary content, headings |
| `text-text-body` | mid | Body copy, labels |
| `text-text-quiet` | muted | Placeholders, disabled |
| `text-text-on-accent` | bright | Text on accent/gradient backgrounds |
| `border-border-subtle` | white/0.1 | Default card/panel border |
| `border-border-strong` | white/0.2 | Hover/emphasis border |
| `border-border-input-field` | white/0.12 | Form field border |
| `border-border-nav` | white/0.08 | Nav divider |
| `ring-focus-ring` | purple | Focus rings on inputs/buttons |
| `text-status-success` etc. | green/yellow/red/blue | Success/warning/error/info |

## Workflow

```bash
# 1. Edit tokens.json (DTCG format with $value/$type)
# 2. Rebuild dist/
node build.mjs
# 3. Commit dist/ — generated files are checked in so consumers don't need to rebuild
git add tokens.json dist/
```

## Importing

**CSS** (each app's `globals.css`):
```css
@import '@imajin/tokens/dist/variables.css';
```

**Tailwind** (`packages/config/tailwind.config.js`):
```js
const tokens = require('@imajin/tokens/dist/tailwind.js');
module.exports = {
  theme: { extend: tokens },
};
```

## Rules

1. **App code never references raw tokens.** No `bg-imajin-orange` — use `bg-accent`.
2. **Add a semantic alias before using a raw token in a new place.** If you find
   yourself reaching for a raw color in a component, that's a missing semantic
   token; add it to `tokens.json` first.
3. **Generated `dist/` is committed.** Don't add it to .gitignore — downstream
   consumers shouldn't need a build step.

See also: `DESIGN.md` (visual spec), issue #808 (architecture).
