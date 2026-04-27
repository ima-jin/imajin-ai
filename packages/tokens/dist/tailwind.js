/** @type {import('tailwindcss').Config['theme']['extend']} */
module.exports = {
  colors: {
    imajin: {
      purple: '#8b5cf6',
      blue: '#6366f1',
      red: '#ef4444',
      orange: '#f97316'
    },
    surface: {
      base: '#0a0a0f',
      surface: '#12121a',
      elevated: '#1a1a26',
      input: '#15151f'
    },
    primary: '#f0f0f5',
    secondary: '#9393a8',
    muted: '#5a5a72',
    success: '#22c55e',
    warning: '#eab308',
    error: '#ef4444',
    info: '#6366f1',
    interactive: {
      light: 'rgba(255, 255, 255, 0.1)',
      'light-hover': 'rgba(255, 255, 255, 0.2)',
      input: 'rgba(255, 255, 255, 0.12)',
      secondary: 'rgba(255, 255, 255, 0.15)',
      nav: 'rgba(255, 255, 255, 0.08)',
      'scrollbar-thumb': 'rgba(139, 92, 246, 0.3)'
    },
    'sunset-gradient': 'linear-gradient(135deg, #8b5cf6, #6366f1, #ef4444, #f97316)'
  },
  spacing: {
    '1': '4px',
    '2': '8px',
    '3': '12px',
    '4': '16px',
    '6': '24px',
    '8': '32px',
    '12': '48px',
    '16': '64px'
  },
  borderRadius: {
    none: '0'
  },
  boxShadow: {
    glow: '0 0 20px rgba(139, 92, 246, 0.15)'
  },
  fontFamily: {
    mono: ['\'JetBrains Mono\'', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', 'monospace'],
    sans: ['\'Inter\'', 'ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'Helvetica Neue', 'Arial', 'sans-serif']
  },
  fontWeight: {
    regular: 400,
    medium: 500,
    bold: 700
  },
  fontSize: {
    label: '0.6875rem',
    nav: '0.8125rem',
    body: '0.875rem',
    'heading-sm': '1.5rem',
    'heading-md': '2rem',
    'heading-lg': '2.5rem',
    'hero-sm': '2.5rem',
    'hero-md': '3rem',
    'hero-lg': '4rem'
  },
  letterSpacing: {
    tight: '-0.03em',
    heading: '-0.02em',
    normal: '0',
    nav: '0.02em',
    label: '0.05em'
  }
};
