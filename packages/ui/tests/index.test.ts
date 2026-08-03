import { describe, expect, it } from 'vitest';
import { NavBar, Button } from '../src/index';

describe('@imajin/ui main entry', () => {
  it('exports NavBar and Button as components', () => {
    expect(NavBar).toBeTypeOf('function');
    expect(Button).toBeTypeOf('function');
  });
});
