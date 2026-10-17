// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import postcss, { type AtRule } from 'postcss';
import tailwindcss from 'tailwindcss';

const getInvoiceMock = vi.hoisted(() => vi.fn());
vi.mock('@/src/lib/pay/payment-requests/service', () => ({
  getPaymentRequestInvoiceByHandle: getInvoiceMock,
}));
vi.mock('next/navigation', () => ({
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  usePathname: () => '/pay/r/ph_print',
}));

const { default: PayByHandlePage } = await import('../page');
const require = createRequire(import.meta.url);
const appRoot = path.join(__dirname, '../../../../..');
const css = readFileSync(path.join(__dirname, '..', 'invoice-print.css'), 'utf8');
const layout = readFileSync(path.join(appRoot, 'app/layout.tsx'), 'utf8');
const bodyClasses = layout.match(/<body className="([^"]+)"/)?.[1];
const invoice = {
  kind: 'invoice',
  lineItems: [{ name: 'Platform build', description: 'Phase 1 delivery', amount: 100_000, quantity: 2 }],
  totalAmount: 226_000,
  subtotalAmount: 200_000,
  taxTotalAmount: 26_000,
  taxes: [{ jurisdiction: 'CA-ON', kind: 'GST/HST', rateBps: 1300, amount: 26_000, registrationNumber: '123456789RT0001' }],
  currency: 'CAD',
  issuerDisplayName: 'Imajin Inc',
  issuerAddress: '1 Example St\nToronto, ON M5V 1A1',
  status: 'paid',
  invoiceNumber: 'INV-3F9A1C07D2',
  issuedAt: '2026-10-01T15:30:00.000Z',
  dueAt: '2026-10-06T00:00:00.000Z',
  paidAt: '2026-10-09T18:45:00.000Z',
  settlement: { method: 'stripe', reference: 'pi_3Abc123' },
  paidBy: null,
  card: true,
  emt: null,
};

let markup: string;
let issuedMarkup: string;
let utilities: string;

function parseRules(source: string): CSSRule[] {
  const style = document.createElement('style');
  style.textContent = source;
  document.head.append(style);
  const rules = Array.from(style.sheet?.cssRules ?? []);
  style.remove();
  return rules;
}

/** jsdom does not emulate print media; activate only print rules explicitly. */
function activatePrint(source: string): string {
  return parseRules(source).map((rule) => {
    if (rule instanceof CSSMediaRule && rule.conditionText === 'print') {
      return Array.from(rule.cssRules, (child) => child.cssText).join('\n');
    }
    return rule.cssText;
  }).join('\n');
}

function mount(theme: string, styles: string[], pageMarkup = markup): void {
  document.documentElement.className = theme;
  document.body.className = bodyClasses ?? '';
  // Providers render fragments, so nav, invoice and toast chrome are body siblings.
  document.body.innerHTML = `<nav class="block bg-white dark:bg-gray-900">Navigation</nav>
    ${pageMarkup}<aside class="fixed flex">Toast chrome</aside>`;
  for (const source of styles) {
    const style = document.createElement('style');
    style.textContent = source;
    document.head.append(style);
  }
}

function computed(selector: string): CSSStyleDeclaration {
  const element = document.querySelector(selector);
  expect(element, `rendered ${selector}`).not.toBeNull();
  return globalThis.getComputedStyle(element as Element);
}

beforeAll(async () => {
  expect(bodyClasses, 'use the actual root layout utility classes').toBeDefined();
  getInvoiceMock.mockResolvedValue(invoice);
  markup = renderToStaticMarkup(await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_print' }) }));
  getInvoiceMock.mockResolvedValue({ ...invoice, status: 'issued', paidAt: null, settlement: null });
  issuedMarkup = renderToStaticMarkup(await PayByHandlePage({ params: Promise.resolve({ handle: 'ph_print' }) }));
  const config = require(path.join(appRoot, 'tailwind.config.js'));
  const result = await postcss([tailwindcss({
    ...config,
    content: [{ raw: `<body class="${bodyClasses}">${markup}${issuedMarkup}</body><nav class="block bg-white dark:bg-gray-900"></nav><aside class="fixed flex"></aside>`, extension: 'html' }],
  })]).process('@tailwind base; @tailwind utilities;', { from: undefined });
  utilities = result.css;
});

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
  document.body.className = '';
  document.documentElement.className = '';
});

describe('invoice-print.css — declaration contract (#2661, #2862)', () => {
  it('keeps every rule inside the single print media block and uses no importance overrides', () => {
    const rules = parseRules(css);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toBeInstanceOf(CSSMediaRule);
    expect((rules[0] as CSSMediaRule).conditionText).toBe('print');
    expect(css).not.toContain('!important');
  });

  it('preserves every original declaration value, including paper geometry and color adjustment', () => {
    const media = postcss.parse(css).nodes.find((node) => node.type === 'atrule') as AtRule;
    const declarations = (media.nodes ?? []).map((rule) => {
      if (rule.type === 'rule' || rule.type === 'atrule') {
        return (rule.nodes ?? [])
          .filter((declaration) => declaration.type === 'decl')
          .map((declaration) => `${declaration.prop}: ${declaration.value}`);
      }
      return [];
    });
    expect(declarations).toEqual([
      ['size: letter', 'margin: 0.6in'],
      ['background: #fff', 'color: #111', 'height: auto', 'min-height: 0'],
      ['display: none'],
      ['display: none'],
      ['max-width: none', 'margin: 0', 'padding: 0'],
      ['padding: 0', 'border: 0', 'border-radius: 0', 'box-shadow: none', '-webkit-print-color-adjust: exact', 'print-color-adjust: exact'],
      ['color: #111', 'background: transparent', 'border-color: #bbb'],
      ['color: #555'],
      ['color: #166534', 'border-color: #166534'],
      ['break-inside: avoid', 'page-break-inside: avoid'],
    ]);
  });
});

describe.each([
  ['light', 'print first'],
  ['light', 'utilities first'],
  ['dark', 'print first'],
  ['dark', 'utilities first'],
])('invoice cascade — %s theme, %s', (theme, order) => {
  function mountPrint(): void {
    const printStyles = activatePrint(css);
    const utilityStyles = activatePrint(utilities);
    const styles = [utilityStyles, printStyles];
    if (order === 'print first') styles.reverse();
    mount(theme, styles);
  }

  it('leaves the screen presentation unchanged with the print stylesheet loaded', () => {
    mount(theme, [utilities]);
    const selectors = ['html', 'body', '.invoice-page', '.invoice-sheet', '.invoice-muted', '.invoice-stamp', 'nav', '[data-print="hide"]'];
    const before = selectors.map((selector) => computed(selector).cssText);
    const style = document.createElement('style');
    style.textContent = css;
    if (order === 'print first') {
      document.head.prepend(style);
    } else {
      document.head.append(style);
    }
    expect(selectors.map((selector) => computed(selector).cssText)).toEqual(before);
    expect(computed('body').minHeight).toBe(`${globalThis.innerHeight}px`);
    expect(computed('.invoice-page').maxWidth).toBe('512px');
    expect(computed('.invoice-sheet').padding).toBe('24px');
  });

  it('overrides min-h-screen and dark body colors without relying on stylesheet order', () => {
    mountPrint();
    for (const selector of ['html', 'body']) {
      const style = computed(selector);
      expect(style.backgroundColor).toBe('rgb(255, 255, 255)');
      expect(style.color).toBe('rgb(17, 17, 17)');
      expect(style.height).toBe('auto');
      expect(style.minHeight).toBe('0px');
    }
  });

  it('removes wrapper utilities and flattens the sheet while preserving its content', () => {
    mountPrint();
    const page = computed('.invoice-page');
    expect(page.maxWidth).toBe('none');
    expect(page.margin).toBe('0px');
    expect(page.padding).toBe('0px');
    const sheet = computed('.invoice-sheet');
    expect(sheet.padding).toBe('0px');
    expect(sheet.borderTopWidth).toBe('0px');
    expect(sheet.borderRadius).toBe('0px');
    expect(sheet.boxShadow).toBe('none');
    expect(sheet.backgroundColor).toBe('rgba(0, 0, 0, 0)');
    expect(sheet.display).not.toBe('none');
    expect(page.display).not.toBe('none');
  });

  it('hides navigation, toast chrome and every screen-only control, not document rows', () => {
    mountPrint();
    for (const element of document.querySelectorAll('nav, aside, [data-print="hide"]')) {
      expect(globalThis.getComputedStyle(element).display).toBe('none');
    }
    for (const element of document.querySelectorAll('[data-invoice-row]')) {
      const style = globalThis.getComputedStyle(element);
      expect(style.display).not.toBe('none');
      expect(style.breakInside).toBe('avoid');
      expect(style.pageBreakInside).toBe('avoid');
    }
  });

  it('hides issued-invoice Pay now and sign-in actions through their screen-only ancestor', () => {
    const styles = [activatePrint(utilities), activatePrint(css)];
    if (order === 'print first') styles.reverse();
    mount(theme, styles, issuedMarkup);
    const actions = Array.from(document.querySelectorAll('button, a'))
      .filter((element) => /Pay now|Sign in to pay/.test(element.textContent ?? ''));
    expect(actions).toHaveLength(2);
    for (const action of actions) {
      const hidden = action.closest('[data-print="hide"]');
      expect(hidden).not.toBeNull();
      expect(globalThis.getComputedStyle(hidden as Element).display).toBe('none');
    }
    expect(document.querySelector('.invoice-stamp')).toBeNull();
    expect(computed('.invoice-sheet').display).not.toBe('none');
  });

  it('outranks text/border utilities and gives muted text and the paid stamp their own colors', () => {
    mountPrint();
    expect(computed('.invoice-sheet h1').color).toBe('rgb(17, 17, 17)');
    expect(computed('.invoice-sheet dd').color).toBe('rgb(17, 17, 17)');
    expect(computed('[data-testid="tax-breakdown"]').borderTopColor).toBe('rgb(187, 187, 187)');
    for (const element of document.querySelectorAll('.invoice-muted')) {
      expect(globalThis.getComputedStyle(element).color).toBe('rgb(85, 85, 85)');
    }
    const stamp = computed('.invoice-stamp');
    expect(stamp.color).toBe('rgb(22, 101, 52)');
    expect(stamp.borderTopColor).toBe('rgb(22, 101, 52)');
    expect(stamp.borderTopWidth).toBe('4px');
  });
});
