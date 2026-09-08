import StyleDictionary from 'style-dictionary';
import { formats } from 'style-dictionary/enums';

const { cssVariables } = formats;

// Register a custom dimension transform that preserves original units (rem, em, px)
StyleDictionary.registerTransform({
  name: 'dimension/preserve-unit',
  type: 'value',
  filter: (token) => token.$type === 'dimension',
  transform: (token) => {
    const val = token.$value ?? token.value;
    // If already a string with a unit suffix, keep it as-is
    if (typeof val === 'string' && /(px|rem|em|%|vh|vw|ch)$/.test(val)) {
      return val;
    }
    // Otherwise fallback to px
    return `${val}px`;
  },
});

const sd = new StyleDictionary({
  source: ['tokens.json'],
  platforms: {
    css: {
      // Use web transforms but override dimension to preserve rem/em
      transforms: [
        'attribute/cti',
        'name/kebab',
        'time/seconds',
        'dimension/preserve-unit',
        'color/css',
        'fontFamily/css',
      ],
      buildPath: 'dist/',
      files: [{
        destination: 'variables.css',
        format: cssVariables,
        options: {
          outputReferences: true,
          selector: ':root',
        },
      }],
    },
    tailwind: {
      buildPath: 'dist/',
      transforms: ['attribute/cti', 'name/kebab', 'color/css'],
      files: [{
        destination: 'tailwind.js',
        format: 'tailwind',
      }],
    },
  },
});

// --- Raw color token buckets ------------------------------------------------
function createColorBuckets() {
  return { colors: {}, sunset: {}, surface: {}, functional: {}, interactive: {} };
}

function assignColorToken(path, value, buckets) {
  if (path[0] !== 'color') return;
  if (path[1] === 'background') {
    buckets.surface[path[2]] = value;
  } else if (path[1] === 'sunset') {
    buckets.sunset[path[2]] = value;
  } else if (path[1] === 'functional') {
    buckets.functional[path[2].replaceAll('text-', '')] = value;
  } else if (path[1] === 'interactive') {
    buckets.interactive[path[2].replaceAll('border-', '')] = value;
  } else if (path[1] === 'gradient' && path[2] === 'sunset') {
    buckets.colors['sunset-gradient'] = value;
  }
}

// --- Semantic tokens — role-based aliases (app code uses these, not raw) ---
function createSemanticBuckets() {
  return {
    surface: {},
    text: {},
    cta: {},
    border: {},
    status: {},
    accent: null,
    focusRing: null,
  };
}

function assignSemanticToken(path, value, semantic) {
  if (path[0] !== 'semantic') return;
  if (path[1] === 'surface') {
    semantic.surface[path[2]] = value;
  } else if (path[1] === 'text') {
    semantic.text[path[2]] = value;
  } else if (path[1] === 'cta') {
    semantic.cta[path[2]] = value;
  } else if (path[1] === 'border') {
    semantic.border[path[2]] = value;
  } else if (path[1] === 'focus') {
    if (path[2] === 'ring') semantic.focusRing = value;
  } else if (path[1] === 'status') {
    semantic.status[path[2]] = value;
  } else if (path[1] === 'accent' && path.length === 2) {
    semantic.accent = value;
  }
}

// --- Simple scalar-scale tokens (spacing, radius, shadow, font.*) ----------
const SCALE_ROUTES = [
  { match: (path) => path[0] === 'space', bucket: 'spacing', key: (path) => path[1] },
  { match: (path) => path[0] === 'radius', bucket: 'borderRadius', key: (path) => path[1] },
  { match: (path) => path[0] === 'shadow', bucket: 'boxShadow', key: (path) => path[1] },
  { match: (path) => path[0] === 'font' && path[1] === 'family', bucket: 'fontFamily', key: (path) => path[2] },
  { match: (path) => path[0] === 'font' && path[1] === 'weight', bucket: 'fontWeight', key: (path) => path[2] },
  { match: (path) => path[0] === 'font' && path[1] === 'size', bucket: 'fontSize', key: (path) => path[2] },
  { match: (path) => path[0] === 'font' && path[1] === 'tracking', bucket: 'letterSpacing', key: (path) => path[2] },
];

function createScaleBuckets() {
  return {
    spacing: {},
    borderRadius: {},
    boxShadow: {},
    fontFamily: {},
    fontWeight: {},
    fontSize: {},
    letterSpacing: {},
  };
}

function assignScaleToken(path, value, scales) {
  for (const route of SCALE_ROUTES) {
    if (route.match(path)) {
      scales[route.bucket][route.key(path)] = value;
      return;
    }
  }
}

// Raw tokens stay available (imajin-*, surface-*, etc) for use INSIDE packages/ui only.
// Semantic tokens (accent, cta-*, surface-1/2/3, text-heading/body/quiet, border-*, focus-ring,
// status-*) are what app code and primitives should use.
function buildThemeColors(colorBuckets, semantic) {
  return {
    // --- Raw tokens (use only inside packages/ui primitives) ---
    imajin: colorBuckets.sunset,
    surface: colorBuckets.surface,
    ...colorBuckets.functional,
    interactive: colorBuckets.interactive,
    ...colorBuckets.colors,
    // --- Semantic tokens (use everywhere else) ---
    ...(semantic.accent ? { accent: semantic.accent } : {}),
    'cta-primary': semantic.cta.primary,
    'cta-secondary': semantic.cta.secondary,
    'surface-1': semantic.surface['1'],
    'surface-2': semantic.surface['2'],
    'surface-3': semantic.surface['3'],
    'surface-input': semantic.surface.input,
    'text-heading': semantic.text.heading,
    'text-body': semantic.text.body,
    'text-quiet': semantic.text.quiet,
    'text-on-accent': semantic.text['on-accent'],
    'border-subtle': semantic.border.subtle,
    'border-strong': semantic.border.strong,
    'border-input-field': semantic.border.input,
    'border-nav': semantic.border.nav,
    ...(semantic.focusRing ? { 'focus-ring': semantic.focusRing } : {}),
    'status-success': semantic.status.success,
    'status-warning': semantic.status.warning,
    'status-error': semantic.status.error,
    'status-info': semantic.status.info,
  };
}

// Serialize to JS — quote keys with special chars, keep clean identifiers unquoted
function serializeValue(value, indent = 2) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(value)) {
    const items = value.map((v) => serializeValue(v, indent + 2)).join(', ');
    return `[${items}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).map(([k, v]) => {
      const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : `'${k}'`;
      return `${pad}${key}: ${serializeValue(v, indent + 2)}`;
    });
    return `{\n${entries.join(',\n')}\n${' '.repeat(indent - 2)}}`;
  }
  if (typeof value === 'string') {
    return `'${value.replaceAll("'", String.raw`\'`)}'`;
  }
  return String(value);
}

// Register a custom format for Tailwind theme extension
sd.registerFormat({
  name: 'tailwind',
  format: ({ dictionary }) => {
    const colorBuckets = createColorBuckets();
    const semantic = createSemanticBuckets();
    const scales = createScaleBuckets();

    for (const token of dictionary.allTokens) {
      const path = token.path;
      const value = token.$value ?? token.value;
      assignColorToken(path, value, colorBuckets);
      assignSemanticToken(path, value, semantic);
      assignScaleToken(path, value, scales);
    }

    const theme = {
      colors: buildThemeColors(colorBuckets, semantic),
      spacing: scales.spacing,
      borderRadius: scales.borderRadius,
      boxShadow: scales.boxShadow,
      fontFamily: scales.fontFamily,
      fontWeight: scales.fontWeight,
      fontSize: scales.fontSize,
      letterSpacing: scales.letterSpacing,
    };

    const jsString = serializeValue(theme, 2);
    return `/** @type {import('tailwindcss').Config['theme']['extend']} */\nmodule.exports = ${jsString};\n`;
  },
});

await sd.buildAllPlatforms();
console.log('✓ Built tokens to dist/');
