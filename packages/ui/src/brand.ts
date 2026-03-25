/**
 * Imajin brand constants
 * 
 * Single source of truth for taglines, copy, and brand text.
 * Import from @imajin/ui in any app.
 */

export const BRAND = {
  name: 'Imajin',
  nameJp: '今人',
  pronunciation: 'eema-gin',
  
  /** Primary tagline — used on homepage hero */
  tagline: 'The internet that pays you back',
  
  /** Footer line — used across all services */
  footer: 'Part of the Imajin sovereign network',
  
  /** Short sovereign message — used in emails, receipts */
  sovereign: 'No platform. No middleman. Yours.',
  
  /** Links */
  url: 'https://imajin.ai',
  community: 'https://app.dfos.com/j/6hnk8e9r9z8eht3k48z474',
  github: 'https://github.com/ima-jin/imajin-ai',
} as const;
