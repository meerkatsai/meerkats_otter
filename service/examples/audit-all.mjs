// Push every mapped client task through /audit as a task_submitted event,
// then verify the chain. Sequential on purpose: seq must be gap-free and
// ordered, and this makes expected order trivial to check.
//
//   node service/examples/audit-all.mjs [base_url] [tenant_ref]
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const base = process.argv[2] || "https://meerkats-otter.onrender.com";
const tenant = process.argv[3] || "acct_client_test";
const file = fileURLToPath(new URL("./client-task-mappings.json", import.meta.url));
const cases = JSON.parse(readFileSync(file, "utf8"));

const results = [];
for (const c of cases) {
  const event = {
    event_id: randomUUID(),
    tenant_ref: tenant,
    action: "task_submitted",
    actor: { kind: "user", principal_ref: "demo_user", auth_method: "test_harness" },
    subject: { entity_type: c.envelope.task.entity },
    task_ref: {
      conforms_to: "https://meerkats.ai/schemas/task-router/v1.json",
      inline: c.envelope,
    },
    outcome: { status: "ok" },
  };
  const res = await fetch(`${base}/audit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
  const body = await res.json();
  results.push({ id: c.id, prompt: c.prompt, event_id: event.event_id, status: res.status, body });
  console.log(`[${res.status === 201 ? "OK" : "FAIL"}] ${c.id} seq=${body.seq ?? "-"} event_id=${event.event_id}`);
  if (res.status !== 201) console.log(`       ${JSON.stringify(body)}`);
}

const verify = await fetch(`${base}/audit/verify?tenant=${encodeURIComponent(tenant)}`).then((r) => r.json());
console.log(`\nchain verify for tenant=${tenant}:`, verify);
console.log(`appended ${results.filter((r) => r.status === 201).length}/${cases.length}`);

// Dump event_id -> id/prompt mapping so the DB spot-check can cross-reference.
console.log("\n--- event_id -> case id (for DB cross-check) ---");
for (const r of results) console.log(`${r.event_id}  ${r.id}  ${r.prompt.slice(0, 60)}`);
