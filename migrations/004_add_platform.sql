-- Expose the platform a task targets as a first-class column, on both
-- stores. Additive + nullable, no backfill: audit_events is append-only, so
-- pre-existing rows correctly stay NULL forever (same policy as 002/003).
--
-- platform is DERIVED server-side from the task envelope's where clause
-- (dimension = 'platform') and is deliberately NOT part of the hash chain:
-- it is a projection of task_ref, which IS hashed, so tampering with this
-- column is detectable by re-deriving it from task_ref. Keeping it out of
-- HASHED_FIELDS (service/db.mjs) also means every existing row still
-- verifies unchanged.

ALTER TABLE audit_events  ADD COLUMN IF NOT EXISTS platform text;
ALTER TABLE trace_summary ADD COLUMN IF NOT EXISTS platform text;

CREATE INDEX IF NOT EXISTS ix_audit_platform ON audit_events (tenant_ref, platform);
