-- 0200_reconcile_seed_era_drift.sql
-- owner: kernel
-- Reconcile only the seed-era catalog differences recorded in #2865.
--
-- HAZARD: scripts/migrate.mjs:98-100 reads apps/kernel/.env.local BEFORE
-- DATABASE_URL. Running it from a server checkout hits the live DB even
-- with DATABASE_URL exported. Never run this against a real environment
-- yourself: verification is CI/scratch DBs only, from a throwaway checkout
-- without .env.local. Jin owns the post-deploy prod-backup re-diff.
-- No rows are deleted or updated; invalid key data fails loudly.

DO $$
DECLARE
    target record;
    table_oid oid;
    key_attnums smallint[];
    key_sql text;
    null_sql text;
    blocked boolean;
    index_name name;
BEGIN
    FOR target IN
        SELECT * FROM (VALUES
            ('conversation_reads_v2',
             ARRAY['conversation_did', 'did'],
             'conversation_reads_v2_conversation_did_did_pk'),
            ('message_reactions_v2',
             ARRAY['message_id', 'did', 'emoji'],
             'message_reactions_v2_message_id_did_emoji_pk')
        ) AS targets(table_name, key_columns, pk_name)
    LOOP
        table_oid := to_regclass(format('chat.%I', target.table_name));
        IF table_oid IS NULL OR EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = table_oid AND contype = 'p'
        ) THEN
            CONTINUE;
        END IF;

        -- Keep validation and index adoption atomic with respect to writers.
        EXECUTE format('LOCK TABLE chat.%I IN ACCESS EXCLUSIVE MODE', target.table_name);
        IF EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = table_oid AND contype = 'p'
        ) THEN
            CONTINUE;
        END IF;

        SELECT array_agg(a.attnum ORDER BY k.ordinality),
               string_agg(format('%I', k.column_name), ', ' ORDER BY k.ordinality),
               string_agg(format('%I IS NULL', k.column_name), ' OR ' ORDER BY k.ordinality)
        INTO key_attnums, key_sql, null_sql
        FROM unnest(target.key_columns) WITH ORDINALITY AS k(column_name, ordinality)
        JOIN pg_attribute a
          ON a.attrelid = table_oid AND a.attname = k.column_name
         AND a.attnum > 0 AND NOT a.attisdropped;

        IF cardinality(key_attnums) IS DISTINCT FROM cardinality(target.key_columns) THEN
            RAISE EXCEPTION 'Seed drift reconciliation: chat.% is missing expected key columns (%)',
                target.table_name, target.key_columns;
        END IF;

        EXECUTE format('SELECT EXISTS (SELECT 1 FROM chat.%I WHERE %s)',
                       target.table_name, null_sql) INTO blocked;
        IF blocked THEN
            RAISE EXCEPTION 'Seed drift reconciliation: chat.% has NULL key values in (%); no rows changed',
                target.table_name, key_sql;
        END IF;
        EXECUTE format(
            'SELECT EXISTS (SELECT 1 FROM chat.%I GROUP BY %s HAVING count(*) > 1)',
            target.table_name, key_sql
        ) INTO blocked;
        IF blocked THEN
            RAISE EXCEPTION 'Seed drift reconciliation: chat.% has duplicate key values in (%); no rows changed',
                target.table_name, key_sql;
        END IF;

        -- USING INDEX accepts only a standalone, valid, plain unique btree
        -- with default ordering/opclasses. Do not adopt a partial/expression,
        -- covering, differently ordered, or constraint-owned index.
        SELECT c.relname INTO index_name
        FROM pg_index i
        JOIN pg_class c ON c.oid = i.indexrelid
        JOIN pg_am am ON am.oid = c.relam
        WHERE i.indrelid = table_oid
          AND i.indisunique AND i.indisvalid AND i.indisready AND i.indislive
          AND i.indimmediate
          AND am.amname = 'btree'
          AND i.indpred IS NULL AND i.indexprs IS NULL
          AND i.indnkeyatts = cardinality(key_attnums)
          AND i.indnatts = cardinality(key_attnums)
          AND ARRAY(SELECT unnest(i.indkey)) = key_attnums
          AND NOT EXISTS (SELECT 1 FROM unnest(i.indoption) AS opt WHERE opt <> 0)
          AND NOT EXISTS (
              SELECT 1 FROM unnest(i.indclass) AS opclass_oid
              JOIN pg_opclass op ON op.oid = opclass_oid
              WHERE NOT op.opcdefault
          )
          AND NOT EXISTS (
              SELECT 1 FROM unnest(i.indcollation) WITH ORDINALITY AS col(collation_oid, n)
              JOIN pg_attribute a ON a.attrelid = table_oid AND a.attnum = key_attnums[col.n]
              WHERE col.collation_oid <> a.attcollation
          )
          AND NOT EXISTS (SELECT 1 FROM pg_constraint pc WHERE pc.conindid = i.indexrelid)
        ORDER BY c.relname
        LIMIT 1;

        IF index_name IS NOT NULL THEN
            EXECUTE format('ALTER TABLE chat.%I ADD CONSTRAINT %I PRIMARY KEY USING INDEX %I',
                           target.table_name, target.pk_name, index_name);
        ELSE
            EXECUTE format('ALTER TABLE chat.%I ADD CONSTRAINT %I PRIMARY KEY (%s)',
                           target.table_name, target.pk_name, key_sql);
        END IF;
    END LOOP;
END $$;

DO $$
DECLARE
    table_oid oid := to_regclass('chat.conversation_members');
    redundant record;
BEGIN
    IF table_oid IS NULL THEN
        RETURN;
    END IF;
    -- Compare sets, not constraint names or column order. The seed's PK and
    -- standalone idx_conv_members_unique index are deliberately untouched.
    FOR redundant IN
        SELECT pc.conname
        FROM pg_constraint pc
        JOIN pg_class backing_index ON backing_index.oid = pc.conindid
        WHERE pc.conrelid = table_oid AND pc.contype = 'u'
          AND backing_index.relname <> 'idx_conv_members_unique'
          AND ARRAY(
              SELECT a.attname::text
              FROM unnest(pc.conkey) AS key_attnum
              JOIN pg_attribute a ON a.attrelid = table_oid AND a.attnum = key_attnum
              ORDER BY a.attname
          ) = ARRAY['conversation_did', 'member_did']
    LOOP
        EXECUTE format('ALTER TABLE chat.conversation_members DROP CONSTRAINT %I',
                       redundant.conname);
    END LOOP;
END $$;

DO $$
DECLARE
    drifted record;
BEGIN
    FOR drifted IN
        SELECT a.attname
        FROM pg_attribute a
        JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = to_regclass('pay.balance_rollups')
          AND a.atttypid = 'numeric'::regtype
          AND a.attnum > 0 AND NOT a.attisdropped
          AND pg_get_expr(d.adbin, d.adrelid) = '0'
    LOOP
        EXECUTE format('ALTER TABLE pay.balance_rollups ALTER COLUMN %I SET DEFAULT ''0''::numeric',
                       drifted.attname);
    END LOOP;
END $$;
