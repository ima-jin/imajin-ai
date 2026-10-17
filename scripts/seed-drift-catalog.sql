-- Same-database snapshot: preserve OIDs, relfilenodes and raw catalog
-- definitions, not merely pg_dump's logical representation. No normalization.
WITH namespaces AS (
    SELECT oid FROM pg_namespace
    WHERE nspname !~ '^pg_' AND nspname <> 'information_schema'
), relations AS (
    SELECT oid FROM pg_class WHERE relnamespace IN (SELECT oid FROM namespaces)
), objects AS (
    SELECT 'namespace' AS kind, oid::text AS id, to_jsonb(n) AS value
      FROM pg_namespace n WHERE oid IN (SELECT oid FROM namespaces)
    UNION ALL
    SELECT 'relation', oid::text, to_jsonb(c)
      FROM pg_class c WHERE oid IN (SELECT oid FROM relations)
    UNION ALL
    SELECT 'attribute', attrelid || ':' || attnum, to_jsonb(a)
      FROM pg_attribute a WHERE attrelid IN (SELECT oid FROM relations)
    UNION ALL
    SELECT 'constraint', oid::text, to_jsonb(c)
      FROM pg_constraint c WHERE connamespace IN (SELECT oid FROM namespaces)
    UNION ALL
    SELECT 'default', oid::text, to_jsonb(d)
      FROM pg_attrdef d WHERE adrelid IN (SELECT oid FROM relations)
    UNION ALL
    SELECT 'index', indexrelid::text, to_jsonb(i)
      FROM pg_index i WHERE indrelid IN (SELECT oid FROM relations)
    UNION ALL
    SELECT 'trigger', oid::text, to_jsonb(t)
      FROM pg_trigger t WHERE tgrelid IN (SELECT oid FROM relations)
    UNION ALL
    SELECT 'type', oid::text, to_jsonb(t)
      FROM pg_type t WHERE typnamespace IN (SELECT oid FROM namespaces)
    UNION ALL
    SELECT 'function', oid::text, to_jsonb(p)
      FROM pg_proc p WHERE pronamespace IN (SELECT oid FROM namespaces)
    UNION ALL
    SELECT 'sequence', seqrelid::text, to_jsonb(s)
      FROM pg_sequence s WHERE seqrelid IN (SELECT oid FROM relations)
)
SELECT kind, id, value FROM objects ORDER BY kind, id;
