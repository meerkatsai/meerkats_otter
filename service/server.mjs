// Meerkats DSL service: schema registry + validation + append-only audit.
import Fastify from "fastify";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { appendAudit, verifyChain, upsertTraceSummary, getTraceSummary } from "./db.mjs";

const dir = fileURLToPath(new URL("./schemas/", import.meta.url));

// Load every *.schema.json, register in ajv, and index by $id path.
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const byPath = {}; // "/schemas/<family>/v1.json" -> schema object
let routerId = null;
for (const f of readdirSync(dir).filter((f) => f.endsWith(".schema.json"))) {
  const s = JSON.parse(readFileSync(dir + f, "utf8"));
  ajv.addSchema(s);
  const path = new URL(s.$id).pathname; // e.g. /schemas/query_and_act/v1.json
  byPath[path] = s;
  if (s.$id.endsWith("task-router/v1.json")) routerId = s.$id;
}
const validateTask = ajv.getSchema(routerId);
const validateTrace = ajv.getSchema("https://meerkats.ai/schemas/task-trace/v1.json");

const app = Fastify({ logger: true });

app.get("/healthz", async () => ({ ok: true, schemas: Object.keys(byPath).length }));

// Serve each schema at its canonical $id path so cross-file $refs resolve over HTTP.
app.get("/schemas/:family/v1.json", async (req, reply) => {
  const s = byPath[`/schemas/${req.params.family}/v1.json`];
  if (!s) return reply.code(404).send({ error: "unknown schema" });
  return s;
});

// Validate a task envelope against the router.
app.post("/validate", async (req, reply) => {
  const ok = validateTask(req.body);
  if (ok) return { valid: true };
  return reply.code(422).send({ valid: false, errors: validateTask.errors });
});

// Append an audit event (server assigns seq, prev_hash, hash, recorded_at).
app.post("/audit", async (req, reply) => {
  const e = req.body ?? {};
  if (!e.event_id || !e.tenant_ref || !e.action || !e.actor || !e.subject)
    return reply.code(400).send({ error: "event_id, tenant_ref, action, actor, subject required" });
  try {
    const r = await appendAudit(e);
    return reply.code(201).send(r);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "append failed" });
  }
});

// Verify a tenant's chain end to end.
app.get("/audit/verify", async (req, reply) => {
  const t = req.query.tenant;
  if (!t) return reply.code(400).send({ error: "tenant required" });
  return verifyChain(t);
});

// Record one request's trace: validate the full trajectory against
// task-trace-v1, then upsert the low-cardinality trace_summary row (the span
// firehose itself belongs in a telemetry backend, not here — see
// migrations/001_init.sql). tenant_ref travels alongside the trace rather
// than inside it because the schema's trace object has no tenant_ref field
// (server-side scope, matching the audit-log schema's convention).
app.post("/trace", async (req, reply) => {
  const { tenant_ref, trace } = req.body ?? {};
  if (!tenant_ref) return reply.code(400).send({ error: "tenant_ref required" });
  if (!trace) return reply.code(400).send({ error: "trace required" });

  const ok = validateTrace(trace);
  if (!ok) return reply.code(422).send({ valid: false, errors: validateTrace.errors });

  const latency_ms = trace.completed_at
    ? Math.max(0, new Date(trace.completed_at) - new Date(trace.received_at))
    : null;

  try {
    const r = await upsertTraceSummary({
      trace_id: trace.trace_id,
      tenant_ref,
      task_type: trace.classification?.task_type,
      status: trace.outcome?.status ?? "in_progress",
      latency_ms,
      output_ref: trace.outcome?.output?.ref ?? null,
    });
    return reply.code(201).send(r);
  } catch (err) {
    req.log.error(err);
    return reply.code(500).send({ error: "trace write failed" });
  }
});

// Fetch a trace's summary row (the full span trajectory lives in your
// telemetry backend, keyed by the same trace_id).
app.get("/trace/:id", async (req, reply) => {
  const r = await getTraceSummary(req.params.id);
  if (!r) return reply.code(404).send({ error: "not found" });
  return r;
});

const port = Number(process.env.PORT) || 8080;
app.listen({ port, host: "0.0.0.0" }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
