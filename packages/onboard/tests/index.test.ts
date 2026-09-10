import { describe, expect, it } from 'vitest';
import { OnboardGate } from '../src/index';

// Smoke-import the real barrel (not vi.mock'd) so the package's actual
// source — including the top-of-file 'use client' directive required for
// tsup's single-bundle dist/index.js (#2142) — is exercised by the suite.
// Nothing in this monorepo's test suite otherwise imports @imajin/onboard,
// so without this file the real src/index.tsx never loads under test.
describe('@imajin/onboard main entry', () => {
  it('exports OnboardGate as a component', () => {
    expect(OnboardGate).toBeTypeOf('function');
  });
});
