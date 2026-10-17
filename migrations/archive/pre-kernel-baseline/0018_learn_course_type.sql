-- Add course_type column to courses
ALTER TABLE learn.courses ADD COLUMN IF NOT EXISTS course_type text DEFAULT 'course';

-- Set pitch decks to 'deck' type
UPDATE learn.courses SET course_type = 'deck' WHERE slug IN ('imajin-pitch', 'imajin-pitch-v2');
-- AgentCon is also a deck
UPDATE learn.courses SET course_type = 'deck' WHERE slug = 'agentcon-architecture-of-trust';
