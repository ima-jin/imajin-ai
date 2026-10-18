import { describe, expect, it } from 'vitest';
import { onboardEmail } from '../onboard-email';

const verifyUrl = 'https://kernel.example/auth/api/onboard/verify?token=fixture';

describe('onboardEmail', () => {
  it.each(['name', 'context', 'onBehalfOf'] as const)('escapes HTML injection in %s', (field) => {
    const injection = `<img src=x onerror="alert('injected')"> & <script>evil()</script>`;
    const html = onboardEmail({ verifyUrl, [field]: injection });

    expect(html).toContain('&lt;img src=x onerror=&quot;alert(&#39;injected&#39;)&quot;&gt; &amp; &lt;script&gt;evil()&lt;/script&gt;');
    expect(html).not.toContain(injection);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain(`href="${verifyUrl}"`);
  });

  it('preserves ordinary labels and the verification link', () => {
    const html = onboardEmail({ verifyUrl, name: 'Buyer', context: 'access your order', onBehalfOf: 'Example App' });

    expect(html).toContain('Hi Buyer,');
    expect(html).toContain('access your order</strong>. Verify your email to continue.');
    expect(html).toContain('Sent by this Imajin node on behalf of Example App.');
    expect(html).toContain(`href="${verifyUrl}"`);
  });

  it.each([undefined, ''])('omits optional labels when they are %s', (value) => {
    const html = onboardEmail({ verifyUrl, name: value, context: value, onBehalfOf: value });

    expect(html).toContain('Hi,');
    expect(html).toContain('Verify your email to continue.');
    expect(html).not.toContain("You're about to");
    expect(html).not.toContain('Sent by this Imajin node on behalf of');
  });
});
