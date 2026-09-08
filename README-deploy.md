# Deploy: Neon + Render

This package is ready to deploy. I can't create the accounts, provision Neon, or
push to Render for you — those need your logins and billing. Below are the exact
steps; each is a couple of minutes.

```
deploy/
├─ service/            # the web service (schema registry + validate + audit)
│  ├─ server.mjs
│  ├─ db.mjs
│  ├─ package.json
│  └─ schemas/         # the 5 schemas, served at their $id paths
├─ migrations/001_init.sql
├─ render.yaml         # Render blueprint
└─ .env.example
```

## 1. Neon — create the project + schema

```bash
npm i -g neonctl
neonctl auth                                  # opens browser login
neonctl projects create --name meerkats-dsl   # note the project id
# get the OWNER connection string (for running the migration):
neonctl connection-string --project-id <id> --role-name neondb_owner --database-name neondb
# run the migration (creates tables, immutability trigger, app_writer role):
psql "<owner-connection-string>" -f migrations/001_init.sql
```

Then set the `app_writer` password (the migration seeds `CHANGE_ME`):

```bash
psql "<owner-connection-string>" -c "ALTER ROLE app_writer PASSWORD '<strong-password>';"
```

Build the **app_writer** URL you'll give the service (host/db from the owner URL,
user `app_writer`, `?sslmode=require`) — this is the least-privilege string, not the owner.

## 2. Render — deploy the service

1. Push this `deploy/` folder to a Git repo (GitHub/GitLab).
2. Render → **New → Blueprint** → select the repo → it reads `render.yaml`.
3. When prompted, set `DATABASE_URL` to the **app_writer** connection string.
4. Deploy. Render builds `service/` and runs `node server.mjs`.

CLI alternative: `render blueprint launch` after `render login` (Render CLI).

## 3. Verify

```bash
BASE=https://meerkats-dsl.onrender.com        # your Render URL

curl $BASE/healthz
# -> {"ok":true,"schemas":5}

# validate a task
curl -sX POST $BASE/validate -H 'content-type: application/json' -d '{
 "version":"1.0","task_type":"query",
 "task":{"entity":"campaign","metrics":["roas"]}}'
# -> {"valid":true}

# append an audit event (server assigns seq/prev_hash/hash)
curl -sX POST $BASE/audit -H 'content-type: application/json' -d '{
 "event_id":"11111111-1111-4111-8111-111111111111","tenant_ref":"acct_17",
 "action":"execution_completed",
 "actor":{"kind":"user","principal_ref":"user_842"},
 "subject":{"entity_type":"campaign","entity_ids":["c1"]},
 "resolved_selection_ref":{"digest":"sha256:ccc"},
 "outcome":{"status":"ok","affected_count":1}}'
# -> {"seq":0,"hash":"sha256:...","prev_hash":null}

# verify the chain
curl "$BASE/audit/verify?tenant=acct_17"
# -> {"ok":true,"count":1}
```

## Notes

- **Schema `$id`s point at `meerkats.ai`.** The service serves them at
  `/schemas/<family>/v1.json`. For external `$ref` resolution over HTTP, map
  `meerkats.ai/schemas/*` to this service (Render custom domain). Internal
  validation needs no network — schemas are registered locally in ajv.
- **Audit is append-only** at three layers: the `app_writer` role lacks
  UPDATE/DELETE, a trigger blocks them regardless, and the hash chain makes any
  post-hoc edit detectable via `/audit/verify`.
- **Anchor the chain** for tamper-evidence against a privileged writer: on a
  schedule, export the latest `hash` per tenant to somewhere Neon's admin can't
  rewrite (object storage with object-lock, or a second account).
- **Span firehose does not go to Neon** — only audit + one-row `trace_summary`.
  Point full traces at your telemetry backend (see the DSL developer guide).
- **Secrets**: never commit `.env`. `DATABASE_URL` is set in Render as a secret
  (`sync:false` in the blueprint).
