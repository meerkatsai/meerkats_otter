// Regression test: every mapped client prompt in client-task-mappings.json
// must still validate against the live (or local) service.
//
//   node service/examples/validate-all.mjs [base_url]
//
// Defaults to https://meerkats-otter.onrender.com; pass a local URL to test
// against a dev server instead.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const base = process.argv[2] || "https://meerkats-otter.onrender.com";
const file = fileURLToPath(new URL("./client-task-mappings.json", import.meta.url));
const cases = JSON.parse(readFileSync(file, "utf8"));

let failures = 0;
for (const c of cases) {
  const res = await fetch(`${base}/validate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(c.envelope),
  });
  const body = await res.json();
  const ok = body.valid === true;
  if (!ok) failures++;
  console.log(`[${ok ? "PASS" : "FAIL"}] ${c.id}: ${c.prompt}`);
  if (!ok) console.log(`       errors: ${JSON.stringify(body.errors)}`);
}

console.log(`\n${cases.length - failures}/${cases.length} validated structurally`);
process.exit(failures ? 1 : 0);
