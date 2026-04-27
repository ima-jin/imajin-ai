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

// Register a custom format for Tailwind theme extension
sd.registerFormat({
  name: 'tailwind',
  format: ({ dictionary }) => {
    const tokens = dictionary.allTokens;

    // Extract colors
    const colors = {};
    const sunset = {};
    const surface = {};
    const functional = {};
    const interactive = {};

    // Extract spacing
    const spacing = {};

    // Extract border radius
    const borderRadius = {};

    // Extract shadows
    const boxShadow = {};

    // Extract font families
    const fontFamily = {};

    // Extract font weights
    const fontWeight = {};

    // Extract font sizes
    const fontSize = {};

    // Extract letter spacing
    const letterSpacing = {};

    for (const token of tokens) {
      const path = token.path;
      const value = token.$value ?? token.value;

      // Colors
      if (path[0] === 'color') {
        if (path[1] === 'background') {
          surface[path[2]] = value;
        } else if (path[1] === 'sunset') {
          sunset[path[2]] = value;
        } else if (path[1] === 'functional') {
          const key = path[2].replace('text-', '');
          functional[key] = value;
        } else if (path[1] === 'interactive') {
          const key = path[2].replace('border-', '');
          interactive[key] = value;
        } else if (path[1] === 'gradient' && path[2] === 'sunset') {
          colors['sunset-gradient'] = value;
        }
      }

      // Spacing
      if (path[0] === 'space') {
        spacing[path[1]] = value;
      }

      // Border radius
      if (path[0] === 'radius') {
        borderRadius[path[1]] = value;
      }

      // Shadows
      if (path[0] === 'shadow') {
        boxShadow[path[1]] = value;
      }

      // Font families
      if (path[0] === 'font' && path[1] === 'family') {
        fontFamily[path[2]] = value;
      }

      // Font weights
      if (path[0] === 'font' && path[1] === 'weight') {
        fontWeight[path[2]] = value;
      }

      // Font sizes
      if (path[0] === 'font' && path[1] === 'size') {
        fontSize[path[2]] = value;
      }

      // Letter spacing
      if (path[0] === 'font' && path[1] === 'tracking') {
        letterSpacing[path[2]] = value;
      }
    }

    // Assemble the Tailwind theme extension
    const theme = {
      colors: {
        imajin: sunset,
        surface,
        ...functional,
        interactive,
        ...colors,
      },
      spacing,
      borderRadius,
      boxShadow,
      fontFamily,
      fontWeight,
      fontSize,
      letterSpacing,
    };

    // Serialize to JS — quote keys with special chars, keep clean identifiers unquoted
    function serialize(value, indent = 2) {
      const pad = ' '.repeat(indent);
      if (Array.isArray(value)) {
        const items = value.map((v) => serialize(v, indent + 2)).join(', ');
        return `[${items}]`;
      }
      if (typeof value === 'object' && value !== null) {
        const entries = Object.entries(value).map(([k, v]) => {
          const key = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(k) ? k : `'${k}'`;
          return `${pad}${key}: ${serialize(v, indent + 2)}`;
        });
        return `{\n${entries.join(',\n')}\n${' '.repeat(indent - 2)}}`;
      }
      if (typeof value === 'string') {
        return `'${value.replace(/'/g, "\\'")}'`;
      }
      return String(value);
    }

    const jsString = serialize(theme, 2);
    return `/** @type {import('tailwindcss').Config['theme']['extend']} */\nmodule.exports = ${jsString};\n`;
  },
});

await sd.buildAllPlatforms();
console.log('✓ Built tokens to dist/');
