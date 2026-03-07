import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";

const spec = `openapi: "3.1.0"
info:
  title: imajin learn
  version: "1.0.0"
  description: Courses, modules, lessons, enrollment, and progress tracking.
servers:
  - url: https://learn.imajin.ai
    description: production
  - url: https://dev-learn.imajin.ai
    description: dev
paths:
  /api/courses:
    get:
      summary: List courses
      description: List published courses
    post:
      summary: Create course
      description: Create a new course (creator only)
  /api/courses/{slug}:
    get:
      summary: Get course detail
    patch:
      summary: Update course
    delete:
      summary: Archive course
  /api/courses/{slug}/enroll:
    post:
      summary: Enroll in course
  /api/courses/{slug}/modules:
    get:
      summary: List modules
    post:
      summary: Create module
  /api/courses/{slug}/progress:
    get:
      summary: Get enrollment progress
  /api/my/courses:
    get:
      summary: My enrolled courses
  /api/my/teaching:
    get:
      summary: My created courses
`;

export async function GET() {
  return new NextResponse(spec, {
    headers: { "Content-Type": "text/yaml" },
  });
}
