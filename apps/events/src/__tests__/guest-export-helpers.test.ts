/**
 * Tests for apps/events/src/lib/guest-export-helpers.ts's `buildSurveyValues`.
 *
 * Covers the S6551 fix: a survey answer is stringified via `String()` only
 * when it is already a primitive (string/number/boolean); anything else
 * (e.g. a nested object/array answer) goes through `JSON.stringify` instead
 * of falling through to `Object`'s default `[object Object]` stringification.
 */
import { describe, it, expect } from 'vitest';
import { buildSurveyValues, type SurveyField } from '../lib/guest-export-helpers';

const SURVEY_COLUMNS = ['Survey: Favorite color', 'Survey: Attending days', 'Survey: Subscribed'];

const FIELDS: SurveyField[] = [
  { name: 'color', title: 'Favorite color' },
  { name: 'days', title: 'Attending days' },
  { name: 'subscribed', title: 'Subscribed' },
];

const FORM_FIELD_MAP = new Map([['form_1', FIELDS]]);

describe('buildSurveyValues', () => {
  it('stringifies a string answer as-is', () => {
    const values = buildSurveyValues(
      { survey_form_id: 'form_1', survey_answers: { color: 'blue' } },
      SURVEY_COLUMNS,
      FORM_FIELD_MAP,
    );
    expect(values[0]).toBe('blue');
  });

  it('stringifies a number answer via String()', () => {
    const values = buildSurveyValues(
      { survey_form_id: 'form_1', survey_answers: { color: 42 } },
      SURVEY_COLUMNS,
      FORM_FIELD_MAP,
    );
    expect(values[0]).toBe('42');
  });

  it('stringifies a boolean answer via String()', () => {
    const values = buildSurveyValues(
      { survey_form_id: 'form_1', survey_answers: { subscribed: true } },
      SURVEY_COLUMNS,
      FORM_FIELD_MAP,
    );
    expect(values[2]).toBe('true');
  });

  it('JSON-stringifies an object/array answer instead of using default Object stringification', () => {
    const values = buildSurveyValues(
      { survey_form_id: 'form_1', survey_answers: { days: ['Mon', 'Tue'] } },
      SURVEY_COLUMNS,
      FORM_FIELD_MAP,
    );
    expect(values[1]).toBe(JSON.stringify(['Mon', 'Tue']));
    expect(values[1]).not.toBe('[object Object]');
  });

  it('returns an empty string for a null/undefined answer', () => {
    const values = buildSurveyValues(
      { survey_form_id: 'form_1', survey_answers: { color: null } },
      SURVEY_COLUMNS,
      FORM_FIELD_MAP,
    );
    expect(values[0]).toBe('');
  });
});
