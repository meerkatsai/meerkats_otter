-- Meerkats DSL — Neon initial migration.
-- Run once against a fresh Neon branch:  psql "$ADMIN_DATABASE_URL" -f 001_init.sql
-- ADMIN_DATABASE_URL uses the owner role; the SERVICE connects as app_writer (created below).

-- ── audit_events: append-only, hash-chained system of record ──────────────
CREATE TABLE IF NOT EXISTS audit_events (
  event_id                uuid PRIMARY KEY,
  tenant_ref              text        NOT NULL,
  seq                     bigint      NOT NULL,          -- monotonic per tenant
  recorded_at             text        NOT NULL,          -- exact ISO-8601 that was hashed
  prev_hash               text,                          -- null only for the genesis event
  hash                    text        NOT NULL,
  signature               text,
  trace_id                uuid,
  action                  text        NOT NULL,
  actor                   jsonb       NOT NULL,
  subject                 jsonb       NOT NULL,
  risk_level              text,
  task_ref                jsonb,
  execution_plan_ref      jsonb,
  resolved_selection_ref  jsonb,
  change                  jsonb,
  decision                jsonb,
  outcome                 jsonb,
  UNIQUE (tenant_ref, seq)                               -- gap/dup detection
);

CREATE INDEX IF NOT EXISTS ix_audit_tenant_time    ON audit_events (tenant_ref, recorded_at);
CREATE INDEX IF NOT EXISTS ix_audit_subject_type   ON audit_events (tenant_ref, (subject->>'entity_type'));
CREATE INDEX IF NOT EXISTS ix_audit_actor          ON audit_events (tenant_ref, (actor->>'principal_ref'));
CREATE INDEX IF NOT EXISTS ix_audit_trace          ON audit_events (trace_id);

-- Defense in depth: block mutation/deletion even if a role is granted it.
CREATE OR REPLACE FUNCTION audit_events_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% blocked)', TG_OP;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_events;
CREATE TRIGGER trg_audit_immutable
  BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- ── trace_summary: one low-cardinality row per request (joins to app data) ──
-- The full span firehose does NOT live here — it goes to your telemetry backend.
CREATE TABLE IF NOT EXISTS trace_summary (
  trace_id     uuid PRIMARY KEY,
  tenant_ref   text NOT NULL,
  task_type    text NOT NULL,
  status       text NOT NULL,
  latency_ms   integer,
  output_ref   text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_trace_tenant_time ON trace_summary (tenant_ref, created_at);

-- ── least-privilege service role ────────────────────────────────────────────
-- Replace the password before running, or set it in the Neon dashboard.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_writer') THEN
    CREATE ROLE app_writer LOGIN PASSWORD 'CHANGE_ME';
  END IF;
END $$;

GRANT CONNECT ON DATABASE neondb TO app_writer;               -- adjust db name
GRANT USAGE ON SCHEMA public TO app_writer;
GRANT SELECT, INSERT ON audit_events  TO app_writer;
GRANT SELECT, INSERT, UPDATE ON trace_summary TO app_writer;  -- summaries may be finalized
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events FROM app_writer;

-- ── retention (run later, not at init) ──────────────────────────────────────
-- Keep audit for your full compliance window; never DELETE within it.
-- To scale, convert audit_events to monthly RANGE partitions on recorded_at and
-- drop whole partitions past retention instead of issuing DELETEs.
