import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { APP_VISIBILITIES, isAppVisibility, isVisibilityWidening } from '../visibility';

describe('app visibility contract', () => {
  it.each(APP_VISIBILITIES)('validates %s', visibility => expect(isAppVisibility(visibility)).toBe(true));
  it.each([null, undefined, 'PUBLIC', '', {}, [], false])('rejects %j', visibility => expect(isAppVisibility(visibility)).toBe(false));

  it.each(APP_VISIBILITIES.flatMap(previous => APP_VISIBILITIES.map(next => [previous, next] as const)))(
    'classifies %s → %s by disclosure audience',
    (previous, next) => {
      const order = ['internal', 'private', 'unlisted', 'public'];
      expect(isVisibilityWidening(previous, next)).toBe(order.indexOf(next) > order.indexOf(previous));
    },
  );

  it('documents root API paths and uses the same four-value enum', () => {
    const spec = parse(readFileSync(resolve(__dirname, '../../../../api-spec/registry.yaml'), 'utf8'));
    expect(spec.components.schemas.AppVisibility.enum).toEqual([...APP_VISIBILITIES]);
    expect(spec.paths['/api/registry/apps'].servers).toEqual([{ url: '/', description: 'Current node root (not /registry)' }]);
    expect(spec.paths['/api/registry/apps'].post.requestBody.content['application/json'].schema.allOf[0].$ref).toBe('#/components/schemas/AppWrite');
    expect(spec.paths['/api/registry/apps/{appId}'].patch.description).toContain('AGENT_APPROVAL_REQUIRED');
    expect(spec.components.schemas.AppVisibility.description).toContain('/auth/app-directory?app=<slug>');
  });
});
