-- =============================================================
-- Production Migration: 2026-03-07
-- Run against: imajin_prod on 192.168.1.193
-- =============================================================

BEGIN;

-- =============================================================
-- 1. New schema: learn
-- =============================================================
CREATE SCHEMA IF NOT EXISTS learn;
CREATE SCHEMA IF NOT EXISTS input;

-- learn.courses
CREATE TABLE learn.courses (
    id text NOT NULL PRIMARY KEY,
    creator_did text NOT NULL,
    title text NOT NULL,
    description text,
    slug text UNIQUE,
    price integer DEFAULT 0,
    currency text DEFAULT 'CAD',
    visibility text DEFAULT 'public',
    image_url text,
    tags jsonb DEFAULT '[]',
    metadata jsonb DEFAULT '{}',
    event_slug text,
    status text DEFAULT 'draft',
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE INDEX idx_learn_courses_creator_did ON learn.courses (creator_did);
CREATE INDEX idx_learn_courses_slug ON learn.courses (slug);

-- learn.modules
CREATE TABLE learn.modules (
    id text NOT NULL PRIMARY KEY,
    course_id text NOT NULL REFERENCES learn.courses(id) ON DELETE CASCADE,
    title text NOT NULL,
    description text,
    sort_order integer NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);
CREATE INDEX idx_learn_modules_course_id ON learn.modules (course_id);

-- learn.lessons
CREATE TABLE learn.lessons (
    id text NOT NULL PRIMARY KEY,
    module_id text NOT NULL REFERENCES learn.modules(id) ON DELETE CASCADE,
    title text NOT NULL,
    content_type text NOT NULL DEFAULT 'markdown',
    content text,
    duration_minutes integer,
    sort_order integer NOT NULL,
    metadata jsonb DEFAULT '{}',
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);
CREATE INDEX idx_learn_lessons_module_id ON learn.lessons (module_id);

-- learn.enrollments
CREATE TABLE learn.enrollments (
    id text NOT NULL PRIMARY KEY,
    course_id text NOT NULL REFERENCES learn.courses(id) ON DELETE CASCADE,
    student_did text NOT NULL,
    payment_id text,
    enrolled_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone
);
CREATE INDEX idx_learn_enrollments_student_did ON learn.enrollments (student_did);
CREATE UNIQUE INDEX idx_learn_enrollments_course_student ON learn.enrollments (course_id, student_did);

-- learn.lesson_progress
CREATE TABLE learn.lesson_progress (
    enrollment_id text NOT NULL REFERENCES learn.enrollments(id) ON DELETE CASCADE,
    lesson_id text NOT NULL REFERENCES learn.lessons(id) ON DELETE CASCADE,
    status text DEFAULT 'not_started',
    completed_at timestamp with time zone,
    PRIMARY KEY (enrollment_id, lesson_id)
);

-- =============================================================
-- 2. New table: auth.onboard_tokens
-- =============================================================
CREATE TABLE auth.onboard_tokens (
    id text NOT NULL PRIMARY KEY,
    email text NOT NULL,
    name text,
    token text NOT NULL UNIQUE,
    redirect_url text,
    context text,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);
CREATE INDEX idx_auth_onboard_tokens_email ON auth.onboard_tokens (email);
CREATE INDEX idx_auth_onboard_tokens_token ON auth.onboard_tokens (token);

-- =============================================================
-- 3. New table: connections.graph_invites
-- =============================================================
CREATE TABLE connections.graph_invites (
    id text NOT NULL PRIMARY KEY,
    inviter_did text NOT NULL,
    invitee_email text,
    invitee_did text,
    status text NOT NULL DEFAULT 'pending',
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    accepted_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    note text
);
CREATE INDEX idx_trust_graph_invites_inviter ON connections.graph_invites (inviter_did);
CREATE INDEX idx_trust_graph_invites_email ON connections.graph_invites (invitee_email);
CREATE INDEX idx_trust_graph_invites_did ON connections.graph_invites (invitee_did);
CREATE INDEX idx_trust_graph_invites_status ON connections.graph_invites (status);

-- =============================================================
-- 4. New columns on existing tables
-- =============================================================

-- dykil
ALTER TABLE dykil.surveys ADD COLUMN IF NOT EXISTS fields jsonb;
ALTER TABLE dykil.survey_responses ADD COLUMN IF NOT EXISTS answers jsonb;

-- pay
ALTER TABLE pay.balances ADD COLUMN IF NOT EXISTS cash_amount numeric DEFAULT 0;
ALTER TABLE pay.balance_rollups ADD COLUMN IF NOT EXISTS earned numeric DEFAULT 0;
ALTER TABLE pay.balance_rollups ADD COLUMN IF NOT EXISTS spent numeric DEFAULT 0;

-- =============================================================
-- 5. Grant permissions to imajin user
-- =============================================================
GRANT USAGE ON SCHEMA learn TO imajin;
GRANT USAGE ON SCHEMA input TO imajin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA learn TO imajin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA input TO imajin;

COMMIT;
