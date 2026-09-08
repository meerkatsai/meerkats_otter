# Client task mappings

`client-task-mappings.json` maps 26 real client-style natural-language asks
(gathered 2026-09-08) to `task-router/v1` envelopes, and doubles as a
regression set — run it against the service any time the schemas or
`/validate` change:

```bash
node service/examples/validate-all.mjs                              # live
node service/examples/validate-all.mjs http://localhost:8099        # local
```

All 26 currently validate structurally. Structural pass means the shape
matches the DSL grammar — it does **not** confirm field names (`platform`,
`roas`, `campaign_name`, ...) resolve against a real metrics catalog. That's
the separate phase-2 semantic validator described in `query_and_act-v1`'s
top-level `description`, which this service does not implement yet.

`audit-all.mjs` pushes every mapping through `/audit` as a `task_submitted`
event (one shared hash chain, so `/audit/verify` proves nothing was
dropped/reordered) and prints the event_id -> case id mapping for
cross-checking actual row content:

```bash
node service/examples/audit-all.mjs                                          # live, tenant=acct_client_test
node service/examples/audit-all.mjs http://localhost:8099 acct_my_tenant     # local, custom tenant
```

Note: audit is designed for *mutating* events — per `audit-log-v1`'s own
description, "mutation is confined to the action and workflow intents", so
production wouldn't normally audit read-only `query` tasks like these 26.
This script exists to exercise the audit plumbing (append, chain integrity,
content correctness) against realistic payloads, not to model real usage.

## Confirmed schema gaps (not mapping mistakes — the grammar itself can't say this)

1. **Compound / cross-dimension "OR" prompts** (id `10a`/`10b`) — a single
   prompt like "ROI<1 on Flipkart *and* ACOS>100% on Amazon" can't be one
   `query_task`: `where`/`having` are pure-AND arrays, no OR/union
   construct exists in `query_and_act/v1`. Decompose into N tasks at the
   planner layer instead of extending the schema — confirmed as expected
   behavior, not a gap to fix (2026-09-08).

2. **`status`-style asks** (id `5`) — "status" isn't a metric, only usable
   as a `dimension`; since `query_task.task.metrics` is required and
   non-empty, a filler metric is needed alongside it.

3. **Entity-vs-entity comparison** (id `20_25`, "price vs competitors") —
   `comparison` only supports `previous_period` or another `time_range`,
   not one entity against another (e.g. your product vs a named
   competitor's). Flattened into two side-by-side metrics
   (`price`, `competitor_price`) as the confirmed best current fit.

4. **One-off query vs standing alert** (id `22`/`22_alert`) — "show me
   campaigns that spent over 10,000 yesterday" and "alert me whenever a
   campaign spends over 10,000" produce the same `condition`/`having` shape
   but different `task_type` (`query` vs `alert`). The router can't
   disambiguate this from the metric/threshold alone — needs explicit
   standing-vs-one-off intent from the caller.

5. **Free-text placeholders** (id `6`) — "[a product name]" needs the real
   value substituted at request time; not a schema issue.

`rating`/`review_count` (id `21`, "latest reviews and ratings") were
initially flagged as out-of-family (text/content retrieval) but confirmed
2026-09-08 to belong in `query_and_act` as aggregate metrics — raw review
*text* retrieval would still be a different task family, but that wasn't
what was asked.
