# Dykil — Sovereign Surveys & Forms

**"Don't You Know I'm Local"**

A form and survey engine for the Imajin sovereign stack. Build questions, collect answers, own the data. No tracking, no third-party analytics, no platform extraction.

## Why Dykil Exists

Forms are how you learn things about people. Every platform captures this data and keeps it. Dykil puts form data where it belongs — with the person who asked the question and the person who answered it.

## Use Cases

### 1. Event Integration (Primary — April 1st)

**Pre-event surveys** — After ticket purchase, ask buyers questions. Reduces friction by being post-pay, not pre-pay. Appears alongside the lobby chat on the event page.

- "What's your background?" (helps organizer plan content)
- "Any dietary restrictions?" (for physical events)
- "What do you hope to get out of this?" (shapes the agenda)

**Post-event surveys** — After the event, collect feedback.

- "How was the experience?"
- "What would you improve?"
- "Net promoter score"

### 2. Business Intelligence (The Original DYKIL Thesis)

Collect data on what businesses are currently spending on promotion. Before the launch event:

- "How much does your business spend on advertising per month?"
- "What platforms do you use? (Google, Meta, Instagram, TikTok...)"
- "What's your customer acquisition cost?"
- "How do you currently communicate with repeat customers?"

Then at the event: *"Here's the aggregate. Here's how much you can save by switching to sovereign infrastructure and communicating directly with your customers through the trust graph."*

This is the bridge from "interesting idea" to "here are real numbers from real businesses."

### 3. Cross-App Embeddable Forms

Dykil isn't just an app — it's a form engine that other Imajin apps embed:

- **events.imajin.ai** — pre/post event surveys, RSVP questions
- **profile.imajin.ai** — extended profile questions, skill assessments
- **learn.imajin.ai** — course feedback, knowledge checks, quizzes
- **coffee.imajin.ai** — preference matching ("what kind of conversations interest you?")
- **connections.imajin.ai** — trust graph onboarding ("how do you know this person?")

### 4. Standalone Surveys

Anyone can create a survey at `dykil.imajin.ai/create`, share the link, collect responses. Google Forms replacement that respects privacy.

## Architecture

### Form Schema (JSON)

Forms are defined as JSON — an array of field definitions. This is the core primitive:

```json
{
  "fields": [
    {
      "id": "f1",
      "type": "text",
      "label": "What's your name?",
      "required": true
    },
    {
      "id": "f2",
      "type": "select",
      "label": "How did you hear about us?",
      "options": ["Friend", "Social media", "Search", "Other"],
      "multiple": false
    },
    {
      "id": "f3",
      "type": "rating",
      "label": "How excited are you? (1-5)",
      "min": 1,
      "max": 5
    }
  ]
}
```

### Field Types

| Type | Description | Options |
|------|-------------|---------|
| `text` | Single-line text | `placeholder`, `maxLength` |
| `textarea` | Multi-line text | `placeholder`, `maxLength`, `rows` |
| `select` | Dropdown/radio | `options[]`, `multiple` |
| `rating` | Numeric scale | `min`, `max`, `labels` |
| `boolean` | Yes/No toggle | `trueLabel`, `falseLabel` |
| `number` | Numeric input | `min`, `max`, `step` |
| `email` | Email input | `placeholder` |
| `date` | Date picker | `minDate`, `maxDate` |
| `file` | File upload | `accept`, `maxSize` |
| `matrix` | Grid/table | `rows[]`, `columns[]` |
| `nps` | Net Promoter Score | (0-10 scale, built-in) |

### Form Builder Approach

**Don't build a form builder from scratch.** Use an existing JSON-schema-driven library:

- **SurveyJS** (`survey-react-ui` + `survey-creator-react`) — full drag-and-drop builder, renders from JSON, MIT-licensed, actively maintained. The creator component is the builder; the library component is the renderer. Both consume the same JSON schema.
- **JSON Forms** (`@jsonforms/react`) — lighter, JSON Schema + UI Schema driven, good for programmatic form generation.
- **React Hook Form + Zod** — lowest level, maximum control, but you'd build the builder UI yourself.

**Recommendation:** SurveyJS for the builder (organizers creating forms) + custom lightweight renderer for the respondent side (cleaner UX, matches Imajin design system). Store the SurveyJS-compatible JSON in the `fields` column.

### Data Flow

```
Organizer creates form (builder UI)
  → JSON schema saved to surveys.fields
  → Form linked to event/app via surveys.event_id or embed

Respondent fills form (renderer UI)
  → Answers saved to survey_responses.answers as { fieldId: value }
  → respondent_did links to identity (or null for anonymous)

Organizer views results (dashboard)
  → Aggregated analytics (counts, averages, distributions)
  → Individual responses (if not anonymous)
  → Export to CSV/JSON
```

### Embedding Pattern

Other apps embed dykil forms via:

1. **API** — `GET /api/surveys/{id}` returns the form schema, `POST /api/surveys/{id}/respond` submits answers
2. **React component** — `<DykilForm surveyId="xxx" />` imported from `@imajin/dykil` (future shared package)
3. **iframe** — `dykil.imajin.ai/embed/{id}` for external sites

## Current State

- ✅ Database schema (surveys + survey_responses)
- ✅ CRUD API for surveys
- ✅ Basic create/dashboard/respond pages
- ✅ 6 field types
- ✅ Anonymous response support
- ❌ No form builder UI (just raw JSON)
- ❌ No analytics/results visualization
- ❌ No event integration
- ❌ No embed support
- ❌ Not deployed (missing DATABASE_URL on server)
- ❌ No NavBar integration

## Port Convention

- Dev: 3012
- Prod: 7012
