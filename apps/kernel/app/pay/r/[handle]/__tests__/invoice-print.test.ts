import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const css = readFileSync(path.join(__dirname, '..', 'invoice-print.css'), 'utf8');

/** Body of the single `@media print { … }` block (everything after its opening brace). */
function printBlock(): string {
  const start = css.indexOf('@media print');
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf('{', start) + 1);
}

/** Declarations of the first rule whose selector list contains `selector`. */
function declarationsFor(selector: string): string {
  const block = printBlock();
  const at = block.indexOf(selector);
  expect(at, `selector ${selector} in print block`).toBeGreaterThanOrEqual(0);
  const open = block.indexOf('{', at);
  return block.slice(open + 1, block.indexOf('}', open));
}

describe('invoice-print.css — print-only styling hooks (#2661)', () => {
  it('only styles inside @media print, so the on-screen pay page is untouched', () => {
    const outside = css.slice(0, css.indexOf('@media print')).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    expect(outside).toBe('');
  });

  it('sets a Letter page with margins so the invoice fits one clean page', () => {
    const rule = declarationsFor('@page');
    expect(rule).toContain('size: letter');
    expect(rule).toMatch(/margin:\s*0\.\d+in/);
  });

  it('hides screen-only chrome (print button, Pay now, billed-to input) via [data-print="hide"]', () => {
    expect(declarationsFor("[data-print='hide']")).toMatch(/display:\s*none\s*!important/);
  });

  it('hides everything outside the sheet — the root nav bar — via the :has(.invoice-sheet) rule', () => {
    const rule = declarationsFor('body:has(.invoice-sheet)');
    expect(rule).toMatch(/display:\s*none\s*!important/);
    expect(printBlock()).toContain('*:not(:has(.invoice-sheet))');
  });

  it('forces black-on-white and flattens the dark card so it prints without a dark background', () => {
    expect(declarationsFor('html,')).toMatch(/background:\s*#fff\s*!important/);
    const sheet = declarationsFor('.invoice-sheet *');
    expect(sheet).toMatch(/color:\s*#111\s*!important/);
    expect(sheet).toMatch(/background:\s*transparent\s*!important/);
    expect(declarationsFor('.invoice-sheet {')).toMatch(/border:\s*0\s*!important/);
  });

  it('lifts the root layout\'s min-h-screen so the body cannot spill onto a blank second page', () => {
    const rule = declarationsFor('html,');
    expect(rule).toMatch(/min-height:\s*0\s*!important/);
    expect(rule).toMatch(/height:\s*auto\s*!important/);
  });

  it('removes the screen width cap and padding from the page wrapper', () => {
    const rule = declarationsFor('.invoice-page');
    expect(rule).toMatch(/max-width:\s*none\s*!important/);
    expect(rule).toMatch(/padding:\s*0\s*!important/);
  });

  it('keeps muted text readable and the PAID stamp green, and avoids splitting rows across pages', () => {
    expect(declarationsFor('.invoice-sheet .invoice-muted')).toMatch(/color:\s*#555/);
    expect(declarationsFor('.invoice-sheet .invoice-stamp')).toMatch(/color:\s*#166534/);
    expect(declarationsFor('[data-invoice-row]')).toMatch(/break-inside:\s*avoid/);
  });
});
