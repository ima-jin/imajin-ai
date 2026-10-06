// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import PrintInvoiceButton from '../PrintInvoiceButton';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  globalThis.history.replaceState(null, '', '/');
});

describe('PrintInvoiceButton (#2661)', () => {
  it('is screen-only chrome and prints on click', () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    const { container } = render(<PrintInvoiceButton />);

    expect(container.firstElementChild?.getAttribute('data-print')).toBe('hide');
    fireEvent.click(screen.getByRole('button', { name: 'Print / Download PDF' }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('does not open the print dialog on load without ?print=1', () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb();
      return 1;
    });
    render(<PrintInvoiceButton />);
    expect(print).not.toHaveBeenCalled();
  });

  it('opens the print dialog once on load with ?print=1 (the issuer row link)', () => {
    const print = vi.fn();
    vi.stubGlobal('print', print);
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      cb();
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    globalThis.history.replaceState(null, '', '/pay/r/ph_1?print=1');

    render(<PrintInvoiceButton />);
    expect(print).toHaveBeenCalledTimes(1);
  });
});
