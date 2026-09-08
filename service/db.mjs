// Neon (Postgres) access layer.
// DATABASE_URL points at your Neon branch, using the app_writer role
// (INSERT + SELECT only — UPDATE/DELETE are revoked at the DB, see migrations/001_init.sql).

import pg from "pg";
import { createHash } from "node:crypto";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Neon requires TLS
  max: 5,
});

// The exact field set that is hashed. recorded_at is stored as text so the
// stored bytes are identical to what was hashed (no timestamptz round-trip drift).
const HASHED_FIELDS = [
  "event_id", "tenant_ref", "seq", "recorded_at", "prev_hash",
  "trace_id", "action", "actor", "subject", "risk_level",
  "task_ref", "execution_plan_ref", "resolved_selection_ref",
  "change", "decision", "outcome",
];

function canon(rec) {
  const e = {};
  for (const k of HASHED_FIELDS) if (rec[k] !== undefined && rec[k] !== null) e[k] = rec[k];
  return JSON.stringify(e, Object.keys(e).sort());
}
const sha256 = (s) => "sha256:" + createHash("sha256").update(s).digest("hex");

// Append one audit event, computing seq + prev_hash + hash inside a
// transaction so the per-tenant chain stays gap-free and ordered.
export async function appendAudit(evt) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize concurrent appends per tenant with an advisory lock rather
    // than SELECT ... FOR UPDATE: row-level locking clauses need the UPDATE
    // privilege, which app_writer deliberately doesn't have (see
    // migrations/001_init.sql — immutability layer 1). The lock is
    // transaction-scoped and releases automatically at COMMIT/ROLLBACK.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [evt.tenant_ref]);
    const { rows } = await client.query(
      `SELECT seq, hash FROM audit_events
        WHERE tenant_ref = $1 ORDER BY seq DESC LIMIT 1`,
      [evt.tenant_ref]
    );
    const prev = rows[0] ?? null;
    const rec = {
      ...evt,
      seq: prev ? Number(prev.seq) + 1 : 0,
      prev_hash: prev ? prev.hash : null,
      recorded_at: new Date().toISOString(),
    };
    rec.hash = sha256(canon(rec));

    const j = (v) => (v == null ? null : JSON.stringify(v));
    await client.query(
      `INSERT INTO audit_events
        (event_id, tenant_ref, seq, recorded_at, prev_hash, hash, signature,
         trace_id, action, actor, subject, risk_level,
         task_ref, execution_plan_ref, resolved_selection_ref,
         change, decision, outcome)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        rec.event_id, rec.tenant_ref, rec.seq, rec.recorded_at, rec.prev_hash,
        rec.hash, rec.signature ?? null, rec.trace_id ?? null, rec.action,
        j(rec.actor), j(rec.subject), rec.risk_level ?? null,
        j(rec.task_ref), j(rec.execution_plan_ref), j(rec.resolved_selection_ref),
        j(rec.change), j(rec.decision), j(rec.outcome),
      ]
    );
    await client.query("COMMIT");
    return { seq: rec.seq, hash: rec.hash, prev_hash: rec.prev_hash };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Upsert the one-row-per-request trace summary (full span firehose goes to
// the telemetry backend, not here — see migrations/001_init.sql).
export async function upsertTraceSummary(s) {
  const { rows } = await pool.query(
    `INSERT INTO trace_summary (trace_id, tenant_ref, task_type, status, latency_ms, output_ref)
       VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (trace_id) DO UPDATE SET
       status = EXCLUDED.status,
       latency_ms = EXCLUDED.latency_ms,
       output_ref = EXCLUDED.output_ref
     RETURNING trace_id, tenant_ref, task_type, status, latency_ms, output_ref, created_at`,
    [s.trace_id, s.tenant_ref, s.task_type, s.status, s.latency_ms ?? null, s.output_ref ?? null]
  );
  return rows[0];
}

export async function getTraceSummary(trace_id) {
  const { rows } = await pool.query(
    `SELECT trace_id, tenant_ref, task_type, status, latency_ms, output_ref, created_at
       FROM trace_summary WHERE trace_id = $1`,
    [trace_id]
  );
  return rows[0] ?? null;
}

const AUDIT_COLUMNS = `event_id, tenant_ref, seq, recorded_at, prev_hash, hash, trace_id,
  action, actor, subject, risk_level, task_ref, execution_plan_ref,
  resolved_selection_ref, change, decision, outcome`;

// List a tenant's audit events, newest first, paginated on seq. Pass
// `before` (a seq value, typically the previous page's last row) to page
// further back in time.
export async function listAuditEvents(tenant_ref, { limit = 50, before } = {}) {
  const cappedLimit = Math.min(Math.max(Number(limit) || 50, 1), 500);
  const params = [tenant_ref];
  let where = "tenant_ref = $1";
  if (before !== undefined && before !== null && !Number.isNaN(before)) {
    params.push(before);
    where += ` AND seq < $${params.length}`;
  }
  params.push(cappedLimit);
  const { rows } = await pool.query(
    `SELECT ${AUDIT_COLUMNS} FROM audit_events
      WHERE ${where} ORDER BY seq DESC LIMIT $${params.length}`,
    params
  );
  return rows;
}

// Fetch a single audit event by id (globally unique primary key).
export async function getAuditEvent(event_id) {
  const { rows } = await pool.query(
    `SELECT ${AUDIT_COLUMNS} FROM audit_events WHERE event_id = $1`,
    [event_id]
  );
  return rows[0] ?? null;
}

// Walk a tenant's chain and fully recompute every hash + prev-link.
export async function verifyChain(tenant_ref) {
  const { rows } = await pool.query(
    `SELECT * FROM audit_events WHERE tenant_ref = $1 ORDER BY seq ASC`,
    [tenant_ref]
  );
  let prev = null;
  for (const r of rows) {
    const rec = {
      event_id: r.event_id, tenant_ref: r.tenant_ref, seq: Number(r.seq),
      recorded_at: r.recorded_at, prev_hash: r.prev_hash,
      trace_id: r.trace_id, action: r.action, actor: r.actor, subject: r.subject,
      risk_level: r.risk_level, task_ref: r.task_ref,
      execution_plan_ref: r.execution_plan_ref, resolved_selection_ref: r.resolved_selection_ref,
      change: r.change, decision: r.decision, outcome: r.outcome,
    };
    if ((rec.prev_hash ?? null) !== prev)
      return { ok: false, broke_at: rec.seq, reason: "prev_hash mismatch" };
    if (sha256(canon(rec)) !== r.hash)
      return { ok: false, broke_at: rec.seq, reason: "hash mismatch (row altered)" };
    prev = r.hash;
  }
  return { ok: true, count: rows.length };
}
