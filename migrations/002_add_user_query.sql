-- Meerkats DSL — adds the raw human-language request text to audit_events.
-- Run once against the same Neon branch 001_init.sql was applied to:
--   psql "$ADMIN_DATABASE_URL" -f migrations/002_add_user_query.sql
--
-- Nullable and NOT included in the hash of pre-existing rows (canon() in
-- db.mjs only hashes fields that are present), so this does not invalidate
-- any already-computed hash in the chain. Only events appended after this
-- migration (and after the corresponding service deploy) will carry it —
-- audit is append-only, existing rows are correctly never backfilled.
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS user_query text;
