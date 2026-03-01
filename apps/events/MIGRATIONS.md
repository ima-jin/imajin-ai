# Database Schema Migrations

This document outlines SQL migrations that may be needed to support the new features added in issues #6-9.

## Current Schema Status

The existing schema in `src/db/schema.ts` already includes most required fields:

### Events Table - Already Supported
- ✅ `id`, `did`, `publicKey`, `creatorDid`
- ✅ `title`, `description`
- ✅ `startsAt`, `endsAt` (timing fields)
- ✅ `isVirtual`, `virtualUrl` (virtual event support)
- ✅ `venue`, `address`, `city`, `country` (physical location)
- ✅ `status` (draft, published, cancelled, completed)
- ✅ `imageUrl` (cover images)
- ✅ `tags`, `metadata` (JSONB fields)
- ✅ `podId` (trust pod integration)
- ✅ `createdAt`, `updatedAt`

### Ticket Types Table - Already Supported
- ✅ `id`, `eventId`
- ✅ `name`, `description`
- ✅ `price`, `currency`
- ✅ `quantity`, `sold`
- ✅ `perks`, `metadata`

## Optional Schema Enhancements

If you want to add the fields mentioned in the task description (slug, tagline, cover_image_url, visibility, contact_email), here are the SQL commands:

### Add Optional Fields to Events Table

```sql
-- Add slug for pretty URLs (e.g., /jin-launch-party instead of /evt_xxx)
ALTER TABLE events
ADD COLUMN slug TEXT;

-- Add index for slug lookup
CREATE INDEX idx_events_slug ON events(slug);

-- Add tagline for short description
ALTER TABLE events
ADD COLUMN tagline TEXT;

-- Add cover_image_url as alias/replacement for imageUrl
-- (Note: imageUrl already exists, so this would be redundant unless renaming)
-- If renaming:
ALTER TABLE events
RENAME COLUMN image_url TO cover_image_url;

-- Add visibility field (public, unlisted, private)
ALTER TABLE events
ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';

-- Add contact_email for event organizer contact
ALTER TABLE events
ADD COLUMN contact_email TEXT;
```

### Data Migration for Slug Generation

If you add the slug field, you'll need to generate slugs for existing events:

```sql
-- Generate slugs from titles for existing events
-- This is a simple example - you may want a more sophisticated slug generator
UPDATE events
SET slug = LOWER(
  REGEXP_REPLACE(
    REGEXP_REPLACE(title, '[^a-zA-Z0-9\s-]', '', 'g'),
    '\s+', '-', 'g'
  )
)
WHERE slug IS NULL;

-- Make slug unique by appending event ID if needed
UPDATE events e1
SET slug = slug || '-' || SUBSTRING(id FROM 5)
WHERE EXISTS (
  SELECT 1 FROM events e2
  WHERE e1.slug = e2.slug AND e1.id != e2.id
);
```

## Current Implementation Notes

The implemented features (issues #6-9) work with the **existing schema** without requiring any migrations:

1. **Event Creation (#6)**: Uses existing fields (startsAt, endsAt, isVirtual, virtualUrl, venue, address, city, country, imageUrl)
2. **Dashboard (#7)**: Reads from existing events and ticketTypes tables
3. **Public Event Page (#8)**: Uses existing event fields and metadata
4. **Edit Page (#9)**: Updates existing event fields via PUT /api/events/[id]

## Recommendations

1. **No immediate migrations required** - all features work with current schema
2. **Optional enhancements**:
   - Add `slug` for prettier URLs
   - Add `tagline` as a separate field (currently concatenated with description)
   - Add `visibility` for unlisted/private events
   - Add `contact_email` for organizer contact

3. **If you decide to add these fields**, run the SQL commands above in your PostgreSQL database

## Testing Migrations

Before running migrations in production:

```bash
# Backup your database
pg_dump -U postgres -d imajin_events > backup_$(date +%Y%m%d).sql

# Test migrations on a copy
createdb imajin_events_test
pg_restore -U postgres -d imajin_events_test backup_$(date +%Y%m%d).sql

# Run migrations on test DB first
psql -U postgres -d imajin_events_test < migrations.sql

# Verify the changes
psql -U postgres -d imajin_events_test -c "\d events"
```
