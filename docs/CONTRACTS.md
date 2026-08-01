# Café Copilot — Interface Contracts (dual-orchestrator build)

Two orchestrators build this project in parallel:
- **Claude track** (Fable 5 orchestrating Sonnet builders) — owns `web/`, `agent/`,
  `memory/`, `docs/`, and this file.
- **Codex track** (GPT-5.6 Sol orchestrating its workers) — owns `pos-sync/`, `demo-seed/`,
  and `ops/` (if created).

Neither track edits the other's directories, ever. Cross-track needs are expressed by
changing THIS contract (Claude track edits it; Codex track requests changes via
`STATUS-codex.md`). Design authority: `/Users/mac/Project POS/docs/hackathon/COPILOT_DESIGN.md`.

## Git protocol

- `main` — integration branch. Only the Claude orchestrator merges into it, after review.
- `codex/work` — the Codex track's branch, checked out in its own worktree at
  `/Users/mac/Projects/cafe-copilot-codex`. Codex commits freely there, never to `main`,
  never switches branches, never force-pushes.
- The Claude track works in `/Users/mac/Projects/cafe-copilot` and never edits files inside
  the Codex worktree.
- Status files are append-only journals, one per track (`STATUS-claude.md`,
  `STATUS-codex.md`) so there are never merge conflicts on coordination notes.

## Environment variables (single source: `.env.local`, gitignored, never committed)

| Var | Meaning | Used by |
|---|---|---|
| `CRDB_CONNECTION_STRING` | CockroachDB cluster (agent memory) | Claude track only |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | Bedrock access | Claude track only |
| `POS_SUPABASE_URL` / `POS_SUPABASE_ANON_KEY` | POS staging project (demo café lives here) | Codex track (pos-sync, demo-seed) |

The Codex track does NOT need or receive CockroachDB or AWS credentials. The Claude track
does not run the seed generator. Copy POS staging values from
`/Users/mac/Project POS/.env.staging` (VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY).

## Contract 1 — Daily Summary Document (pos-sync → agent memory)

`pos-sync/` exposes a pure generator; the Claude track embeds/stores its output. Codex never
touches CockroachDB.

- Module: `pos-sync/summarizer.mjs` exporting
  `generateDailySummary({ supabase, businessId, date }) -> SummaryDoc | null`
  (null when the business-local day has no activity), plus a CLI:
  `node pos-sync/cli.mjs --business <id> --date YYYY-MM-DD [--out dir]` writing
  `summary-<businessId>-<date>.json`.
- `SummaryDoc` shape (all money as numbers in business currency; omit nothing, use 0/[]):

```json
{
  "schema_version": 1,
  "business_id": "uuid",
  "date": "YYYY-MM-DD",
  "currency": "LKR",
  "kpis": { "gross_sales": 0, "order_count": 0, "avg_transaction_value": 0 },
  "payment_split": { "cash": 0, "card": 0 },
  "order_type_split": { "dine_in": 0, "takeaway": 0, "delivery": 0 },
  "cash": {
    "sessions_closed": 0, "opening_float_total": 0, "expected_total": 0,
    "counted_total": 0, "over_short_total": 0, "banked_total": 0
  },
  "exceptions": {
    "refunds": { "count": 0, "value": 0 }, "voids": { "count": 0, "value": 0 },
    "paid_in": { "count": 0, "value": 0 }, "paid_out": { "count": 0, "value": 0 },
    "no_sale_count": 0
  },
  "top_items": [ { "name": "", "qty": 0, "revenue": 0 } ],
  "narrative": "One short plain-English paragraph a café owner would understand, stating the day's headline numbers and anything unusual (big over/short, refund spike, unusually quiet)."
}
```

- Business-local calendar day semantics (same convention as the POS End of Day report).
- Read-only: the summariser performs SELECTs only against the POS staging project.

## Contract 2 — Demo Seed Data (demo-seed → POS staging)

- `demo-seed/` creates ONE fictional demo café on the POS **staging** Supabase project
  (`ljnzschozufepfpkzwjy` — hard-refuse any other ref, especially prod
  `iveygqneqlsxvdvdxxgx`; check the URL at startup and abort loudly on mismatch).
- It acts as a real client: signs up a demo owner via Supabase auth (email/password from
  env or flags), runs the same inserts the app's setup wizard performs, then generates
  ~3 weeks of realistic history: staff, tills with floats, daily till sessions
  (opened/closed with blind counts via the `close_till_session` RPC where PIN approval is
  required), orders across order types and payment methods, occasional refunds/voids via
  `record_order_adjustment`, paid-in/out events, no-sales, waste logs, and small
  over/shorts. Realism matters more than volume: weekday/weekend rhythm, morning peaks,
  a couple of anomalous days (one big shortage, one refund-heavy day) for the copilot demo
  narrative.
- Idempotence: `--fresh` flag recreates from scratch; default run refuses if the demo
  business already exists. All demo rows belong to the demo business only.
- Output: prints the demo business id + owner credentials summary (not the password) and
  writes `demo-seed/seed-report.json` (counts per table, date range) for verification.

## Contract 3 — Status journals

Each track appends dated entries to its own status file at the repo root: what was done,
verification results, blockers, and any change requested from the other track. Entries must
be standalone (no "as discussed" references).

## Amendment 1 (2026-07-12, contract owner) — historical timestamps on RPC-driven seed history

Codex-track finding: `close_till_session` / `record_order_adjustment` stamp `now()` and accept
no historical time, so seeded closures/adjustments clump on the seed date. RESOLUTION: the
production RPCs stay exactly as they are — no backdating capability will be added to live
security code for demo convenience. Instead, the Claude-track orchestrator runs a one-time,
demo-business-scoped SQL fixup on staging after seeding (closed_at = opened_at + 9h30m for
clumped sessions; adjustment created_at = its order's created_at + 30m). Applied and verified
2026-07-12: 0 wrong-day sessions, anomalies land on their intended dates (2026-07-04 shortage
−4,800; 4 refunds on 2026-07-08), aggregate variance unchanged (−5,140) since the cash trigger
is session-scoped, not time-scoped. If demo-seed is ever re-run with --fresh, request the
fixup again via STATUS-codex.md.

## Amendment 2 (2026-08-01, product owner) — Approval-gated Copilot actions v1

This amendment supersedes the former strict POS-read-only invariant only for the closed,
approval-gated v1 registry. It also overrides the former dual-track ownership restriction for
this feature: the Café Copilot agent, memory, and web own proposal, confirmation, recovery,
cards, and passive records; Project POS owns migrations, privileged RPCs, audit, policy, and
widget integration. All other ownership and production-preservation rules remain in force.

### Status and gating

Actions are disabled by default. Gate 0 and P1–P6, including the verified staging membership gate,
must pass before P7 may enable one explicitly allowlisted internal staging business. P7 then runs
the adversarial E2E, reconciliation, and monitored action-by-action rollout; its evidence is required
before broader staging availability. Production actions remain disabled. The demo stays read-only
and isolated; it may never execute, receive, or simulate a privileged POS capability.

### Non-negotiable action boundary

- Server derives the verified JWT actor, active owner/manager membership, and business scope for
  every request. There is no auth fallback; browser roles, selected profiles, IDs, and model
  inputs prove nothing. Caller-JWT POS clients remain mandatory, with explicit tenant filters;
  no service-role credential is used by Copilot.
- The registry is a closed, versioned allowlist. A model cannot select an RPC/route/SQL, arbitrary
  payload, target snapshot, or URL. Global, business, and action policy switches are checked by
  both executor and RPC; any switch/version change invalidates pending work.
- A proposal is emitted only as the additive unnamed SSE `action_proposal` frame. SSE never
  carries a result or executes a write. `POST /copilot/actions/confirm` synchronously returns
  terminal JSON; `GET /copilot/actions/{proposalId}` is the authenticated actor/business recovery
  path and must reconcile from POS audit without repeating a write.
- Confirmation is actor-bound and, where required, verifies only that actor's staff PIN. PINs,
  capabilities, service credentials, and raw secrets never enter browser storage, SSE, model
  context, CockroachDB, logs, or audit payloads.
- The server-only executor signs a short-lived JCS-canonical, HMAC-SHA-256 capability; only the
  POS verifier may read its Vault key. Every narrow `SECURITY DEFINER` RPC independently checks
  membership, policy, capability, payload hash, expiry, actor/business/action, PIN and target
  preconditions, then atomically consumes its `jti`, mutates, and appends immutable POS audit.
  Replay returns only the matching narrow terminal result; mismatch fails closed.
- CockroachDB stores principal-scoped proposals, leases, passive operational records, and
  reconciliation observations only. POS audit is authoritative for POS success; there is no
  cross-database transaction or CRDB claim of POS success. Proposal and passive lifecycles are
  immutable/append-only where applicable and tenant-scoped.
- Revisions and expected state/hash protect every mutable target. Undo is a fresh, original-actor
  proposal using a compensating action; it never deletes or rewrites audit/ledger history.
  Owner/manager authorization is required for action visibility and execution.
- Currency remains ISO-4217, including `KWD` (three fixed decimal places); unsupported currencies
  are action-disabled. Existing demo isolation, production safeguards, and ordinary read-only POS
  flows remain unchanged.
