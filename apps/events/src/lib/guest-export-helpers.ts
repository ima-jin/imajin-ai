/**
 * Helpers for the guest-list CSV export route.
 * Extracted from app/api/events/[id]/guests/export.csv/route.ts to reduce cognitive complexity.
 */

import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Duplicate survey detection
// ---------------------------------------------------------------------------

/**
 * Warn when a ticket has more than one survey response (only the most-recent
 * one is exported). Non-fatal — just logs and continues.
 */
export async function warnDuplicateSurveyResponses(
  ticketIds: string[],
  sql: postgres.Sql,
  log: any,
): Promise<void> {
  if (ticketIds.length === 0) return;
  const dupRows = await sql`
    SELECT ticket_id, COUNT(*) as cnt
    FROM dykil.survey_responses
    WHERE ticket_id = ANY(${ticketIds})
    GROUP BY ticket_id
    HAVING COUNT(*) > 1
  `;
  for (const row of dupRows) {
    log.warn(
      { ticketId: row.ticket_id, count: Number(row.cnt) },
      'Ticket has multiple survey responses; using most recent',
    );
  }
}

// ---------------------------------------------------------------------------
// Survey form metadata
// ---------------------------------------------------------------------------

export interface SurveyField {
  name: string;
  title: string;
  exportLabel?: string;
}

export interface SurveyFormData {
  surveyColumns: string[];
  formFieldMap: Map<string, SurveyField[]>;
}

/**
 * Fetch survey form definitions from the DB and build:
 * - `surveyColumns`: ordered list of "Survey: <label>" column header strings
 * - `formFieldMap`: map from form ID to its field list
 */
export async function loadSurveyFormData(
  formIds: string[],
  sql: postgres.Sql,
): Promise<SurveyFormData> {
  const surveyColumns: string[] = [];
  const formFieldMap = new Map<string, SurveyField[]>();

  if (formIds.length === 0) return { surveyColumns, formFieldMap };

  const formRows = await sql`SELECT id, fields FROM dykil.surveys WHERE id = ANY(${formIds})`;
  for (const row of formRows) {
    const mappedFields = extractSurveyFields(row.fields);
    formFieldMap.set(row.id, mappedFields);
    for (const f of mappedFields) {
      const label = f.exportLabel || stripHtml(f.title);
      const colName = `Survey: ${label}`;
      if (!surveyColumns.includes(colName)) {
        surveyColumns.push(colName);
      }
    }
  }

  return { surveyColumns, formFieldMap };
}

function extractSurveyFields(rawFields: unknown): SurveyField[] {
  let fields: Array<{ name: string; title?: string; exportLabel?: string }>;
  if (Array.isArray(rawFields)) {
    fields = rawFields;
  } else if (rawFields && typeof rawFields === 'object' && Array.isArray((rawFields as any).elements)) {
    fields = (rawFields as any).elements;
  } else {
    fields = [];
  }
  return fields.map((f: any) => ({
    name: f.name,
    title: f.title || f.name,
    exportLabel: f.exportLabel,
  }));
}

// ---------------------------------------------------------------------------
// CSV row building
// ---------------------------------------------------------------------------

/**
 * Build the survey-answer values for one ticket row, returning one string per
 * `surveyColumns` entry (empty string when no answer is present).
 */
export function buildSurveyValues(
  ticket: { survey_form_id?: string | null; survey_answers?: Record<string, unknown> | null },
  surveyColumns: string[],
  formFieldMap: Map<string, SurveyField[]>,
): string[] {
  const surveyAnswers = ticket.survey_answers || {};

  if (!ticket.survey_form_id || !formFieldMap.has(ticket.survey_form_id)) {
    return surveyColumns.map(() => '');
  }

  const fields = formFieldMap.get(ticket.survey_form_id)!;
  return surveyColumns.map((colName) => {
    const question = colName.replaceAll('Survey: ', '');
    const field = fields.find((f) => (f.exportLabel || stripHtml(f.title)) === question);
    if (field && field.name in surveyAnswers) {
      const ans = (surveyAnswers as Record<string, unknown>)[field.name];
      if (ans === null || ans === undefined) return '';
      return typeof ans === 'object' ? JSON.stringify(ans) : String(ans);
    }
    return '';
  });
}

// ---------------------------------------------------------------------------
// HTML stripping (used for survey column label cleanup)
// ---------------------------------------------------------------------------

/** Strip HTML tags and collapse whitespace for clean CSV column headers. */
export function stripHtml(s: string): string {
  let out = '';
  let inTag = false;
  for (const ch of s) {
    if (ch === '<') { inTag = true; continue; }
    if (ch === '>') { inTag = false; continue; }
    if (!inTag) out += ch;
  }
  return collapseWhitespace(out);
}

function collapseWhitespace(s: string): string {
  let result = '';
  let prevWasSpace = false;
  for (const ch of s) {
    const isSpace = ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
    if (isSpace) {
      if (!prevWasSpace) result += ' ';
      prevWasSpace = true;
    } else {
      result += ch;
      prevWasSpace = false;
    }
  }
  return result.trim();
}
