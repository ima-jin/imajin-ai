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

export async function GET() {
  return new NextResponse(spec, {
    headers: { "Content-Type": "text/yaml" },
  });
}
