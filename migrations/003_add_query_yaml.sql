-- Meerkats DSL — adds the YAML-rendered task instance to trace_summary.
-- Run once against the same Neon branch 001_init.sql/002_add_user_query.sql
-- were applied to:
--   psql "$ADMIN_DATABASE_URL" -f migrations/003_add_query_yaml.sql
--
-- Nullable, additive only, no backfill of existing rows — server.mjs
-- computes query_yaml from trace.task (js-yaml dump) at POST /trace time,
-- so only traces submitted after this migration + the corresponding
-- deploy will have it.
ALTER TABLE trace_summary ADD COLUMN IF NOT EXISTS query_yaml text;
