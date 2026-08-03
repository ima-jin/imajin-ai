import { describe, expect, it } from 'vitest';
import { FairAccordion, FairEditor } from '../src/react';

describe('@imajin/fair/react entry', () => {
  it('exports FairAccordion as a component', () => {
    expect(FairAccordion).toBeTypeOf('function');
  });

  it('exports FairEditor as a component', () => {
    expect(FairEditor).toBeTypeOf('function');
  });
});
