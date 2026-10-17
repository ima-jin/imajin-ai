-- Cross-database semantic catalog definitions, addressed by qualified names
-- rather than database-local OIDs. Unlike dumps, these values are not normalized.
WITH relations AS (
    SELECT c.oid, n.nspname, c.relname, c.relkind, c.relpersistence,
           c.relreplident, c.relrowsecurity, c.relforcerowsecurity, c.reloptions
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
), definitions AS (
    SELECT 'relation' AS kind, nspname || '.' || relname AS name,
           jsonb_build_array(relkind, relpersistence, relreplident,
               relrowsecurity, relforcerowsecurity, reloptions) AS definition
      FROM relations
    UNION ALL
    SELECT 'column', r.nspname || '.' || r.relname || '.' || a.attname,
           jsonb_build_array(a.attnum, format_type(a.atttypid, a.atttypmod),
               a.attnotnull, a.attidentity, a.attgenerated,
               pg_get_expr(d.adbin, d.adrelid))
      FROM relations r JOIN pg_attribute a ON a.attrelid = r.oid
      LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attnum > 0 AND NOT a.attisdropped
    UNION ALL
    SELECT 'constraint', r.nspname || '.' || r.relname || '.' || c.conname,
           jsonb_build_array(c.contype, c.condeferrable, c.condeferred,
               c.convalidated, pg_get_constraintdef(c.oid))
      FROM relations r JOIN pg_constraint c ON c.conrelid = r.oid
    UNION ALL
    SELECT 'index', r.nspname || '.' || r.relname,
           jsonb_build_array(pg_get_indexdef(i.indexrelid), i.indisunique,
               i.indisprimary, i.indisvalid, i.indisready, i.indislive,
               i.indisreplident, i.indisclustered, i.indnullsnotdistinct)
      FROM relations r JOIN pg_index i ON i.indexrelid = r.oid
)
SELECT kind, name, definition FROM definitions ORDER BY kind, name;
