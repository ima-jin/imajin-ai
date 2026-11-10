import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

const spec = `openapi: "3.1.0"
info:
  title: imajin www
  version: "1.0.0"
  description: Imajin home — articles, health dashboard, app launcher.
servers:
  - url: https://imajin.ai
    description: production
  - url: https://dev-www.imajin.ai
    description: dev
paths:
  /api/alpha:
    post:
      summary: Request alpha access or a demo (no account created)
      description: >-
        Public intake. Five attempts per IP per hour (per kernel worker).
        Empty website honeypot required when supplied. Body limited to 16384 bytes.
        Also accepts application/x-www-form-urlencoded native POST before
        hydration, redirecting on success with 303 to /alpha?received=1 without
        personal data in the URL.
        No submission content is logged. The configured operator receives a
        generic notification via the existing notify send path, without contact
        details, free text or a new email template.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              additionalProperties: false
              required: [name, email, company, intent, purpose]
              properties:
                name: { type: string, minLength: 1, maxLength: 120 }
                email: { type: string, format: email, maxLength: 254 }
                company: { type: string, minLength: 1, maxLength: 200 }
                intent: { type: string, enum: [tester, integrator, partner, demo] }
                purpose: { type: string, minLength: 1, maxLength: 1000 }
                website: { type: string, const: "" }
      responses:
        "201": { description: Stored; someone will reach out }
        "303": { description: Native form stored; redirect to contact confirmation }
        "400": { description: Invalid fields, bot guard or oversized body }
        "429": { description: Rate limited; Retry-After header in seconds }
        "503": { description: Storage temporarily unavailable }
  /api/health:
    get:
      summary: System health check
      description: Returns status of all platform services
      responses:
        "200":
          description: Health status
  /api/subscribe:
    post:
      summary: Email subscription
      description: Subscribe to launch updates
      responses:
        "200":
          description: Subscribed
`;

export function GET() {
  return new NextResponse(spec, {
    headers: { "Content-Type": "text/yaml" },
  });
}
