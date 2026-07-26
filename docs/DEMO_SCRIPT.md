# Demo script — Cafe Copilot

A reproducible walkthrough for judges or anyone verifying the submission. Follows one
continuous conversation with the copilot, framed as a real operational narrative: a cash
shortage, a refund spike found by meaning alone, staff accountability, waste, memory, and a
purchase-order draft.

This is the **authoritative demo surface** — the authenticated widget embedded in the Project
POS manager dashboard (per `docs/RUNBOOK.md` section 1). It is not the standalone
`cafe-copilot.pages.dev` build, which is not on the deployed backend's allowed-origin list as of
this writing and will return `403 Origin is not allowed.` if used.

The release candidate was deployed and this journey was rerun successfully against the real
staging widget on 2026-07-26. Recheck it immediately before recording because external model,
database, and account state can still change.

## Setup

1. Open `https://phase-8-auth.project-pos.pages.dev` in a clean browser window.
2. Sign in with the staging demo-owner email and password from the operator's gitignored
   `.env.local`; do not display or narrate either credential while recording. Row-Level
   Security confines this account to the fictional "Harbour & Bean Demo Café" only.
3. Enter the `DEMO_OWNER_PIN` configured for the seeded staging account. Do not put the PIN in
   this public document or show it in the recording.
4. From the manager dashboard, click the floating Copilot button to open the chat widget.

**If it misbehaves (setup):**
- Sign-in fails or hangs → confirm you're on the POS **staging** dashboard URL above, not a
  production POS URL; the agent backend hard-refuses to run against anything but the staging
  Supabase project, so a production login won't reach the same seeded data.
- The Copilot button doesn't appear or the widget won't open → confirm the signed-in account has
  an **active owner or manager** membership on the demo business; a `403 Access denied: active
  owner or manager membership required` from the backend means that check failed.
- The widget opens but the first message never streams back → check for a `504` (request
  timeout) or `429` (rate limit) in the browser network tab; wait a few seconds and retry once —
  per `docs/RUNBOOK.md` section 7, the rate limiter is per-Lambda-instance, not global, so a
  retry can land on a different instance.

## The conversation, in order

### 1. The cash-shortage anomaly

**Ask:** `Why was the drawer short on July 4th 2026?`

**Proves:** `get_day_summary` — a live, read-only query against the POS staging project
(Supabase), not a cached or precomputed figure. This establishes the baseline: numbers come from
the till, not from memory.

**Expect:** the till was **LKR 4,800 short** — expected **LKR 34,850** vs. counted
**LKR 30,050**, across **18 orders** and **LKR 32,400** gross sales that day.

**If it misbehaves:** if the agent asks for a date instead of answering, the business-local date
context failed to resolve — the system prompt is designed to fail closed to "ask for the date"
rather than guess, so this is a safe failure, not a wrong answer. If a number doesn't match the
figures above, don't assume the agent is wrong before checking whether the demo data has since
been reseeded (`demo-seed/seed.mjs --fresh` regenerates history).

### 2. The refund spike, found by meaning alone (flagship CockroachDB moment)

**Ask:** `Have we had any problems with refunds lately?`

**Proves:** `search_memory` — CockroachDB's native `VECTOR` column and `CREATE VECTOR INDEX`
(`documents_embedding_idx` on the `documents` table), queried with the cosine operator `<=>`.
The question deliberately gives no date; the agent must search stored daily summaries by
meaning, not exact keywords, to find the right day.

**Expect:** the agent surfaces the **8 July spike** — **4 refunds totalling LKR 2,800** — without
ever being told which day to look at.

**If it misbehaves:** if the agent asks which dates you mean instead of searching, it skipped
`search_memory` — try rephrasing to sound more open-ended ("has anything seemed off lately with
refunds?"), since the system prompt instructs the model to call `search_memory` first specifically
for vague/relative questions with no date. If it returns no results at all, confirm the backfill
script (`npm run agent:backfill`) has been run against the current seed data — the 21
vector-indexed daily summaries only exist after that step.

### 3. Staff accountability

**Ask:** `Who were our best staff between July 1st and July 12th 2026?`

**Proves:** `get_staff_performance` — a live join across till sessions, orders, and order
adjustments, attributing refunds/voids to whoever **approved** them (an owner/manager sign-off),
never to whoever rang them up.

**Expect:**
- **Ruwan Jayasinghe** — LKR 174,250 total sales, 102 orders, 6 shifts worked, **LKR +20 net
  over** (cash slightly over across their shifts).
- **Nimal Silva** — LKR 158,700 total sales, 94 orders, **LKR 4,975 net short**.
- **Maya Perera** worked no shifts in the range but **approved 6 refunds (LKR 3,500) and
  2 voids** — the agent should describe these as approved by her, not caused by her.

**If it misbehaves:** if the answer is missing staff entirely or errors out, this is exactly the
failure mode the FK-ambiguity bug (documented in `docs/SUBMISSION.md` "Challenges") used to
cause — check that `agent/tools.mjs`'s `till_sessions` query still pins the
`staff_profiles!till_sessions_business_staff_fkey` embed hint. If refunds/voids are attributed to
the wrong person, re-check that the question and seed data still match the range above.

### 4. Waste

**Ask:** `What are we wasting the most of this month?`

**Proves:** `get_waste_log` — a live query against the waste/comp log, grouped by reason and by
item.

**Expect:** **LKR 3,650** across **4 items** this month — **damaged: LKR 2,150**, **quality
issue: LKR 1,500**.

**If it misbehaves:** if the total doesn't match, confirm "this month" resolved against the
business-local date the agent reported earlier in the conversation, not a different calendar
month than the seeded range covers.

### 5. Memory: save a note, then recall it

**Ask (first):** `Remember this: we switch to the winter menu in November.`

**Proves:** `save_note` — a durable row in the CockroachDB `notes` table, scoped to this business.

**Expect:** a short confirmation that the note was saved.

**Ask (second, same conversation):** `What notes have you saved for me?`

**Proves:** `list_notes` — reading the same row straight back out of CockroachDB, not from
anything cached in the browser tab. For an even stronger version of this proof, hard-reload the
browser tab before asking a memory-recall question like "what did I just ask you?" — the
conversation continues because CockroachDB remembers it, not the tab.

**Expect:** the note about switching to the winter menu in November is listed back.

**If it misbehaves:** if the note isn't listed, confirm the same signed-in business/session was
used for both the save and the list call — notes are scoped per business and (in some access
modes) per actor, by design, not shared across an unrelated session.

### 6. Purchase-order draft

**Ask:** `Draft a purchase order for 20kg of coffee beans and 30 litres of milk from Ceylon Supplies.`

**Proves:** `draft_purchase_order` — saved as a JSONB row in the CockroachDB `drafts` table and
rendered back to the UI as a reviewable card. The agent never places a real order anywhere.

**Expect:** an itemized draft card — 20 kg coffee beans, 30 L milk, supplier "Ceylon Supplies" —
with explicit language that nothing has been ordered and the draft is saved for review.

**If it misbehaves:** if the agent asks a clarifying question about units or supplier instead of
drafting, that's expected behavior for genuinely ambiguous input, not a bug — the tool schema
requires an item name and quantity, and treats supplier/unit as optional context.

## Optional: the honesty check

**Ask:** `How was yesterday?`

**Proves:** the system prompt's hard rule against inventing numbers. If the seeded demo range
does not include "yesterday" relative to when you're running the demo, the agent should say
plainly that there's no activity recorded for that day, rather than fabricating a number to fill
the gap.

**If it misbehaves:** if the agent states any sales figure for a day with no seeded data, that is
a genuine regression against the "never invent a number" rule in `agent/handler.mjs`'s system
prompt and worth flagging, not a demo-data issue.

## General fallback notes

- Every step above depends on the seeded demo café's fixed historical date range. If any figure
  doesn't match, check first whether `demo-seed/seed.mjs --fresh` has been re-run since this
  script was written (see Amendment 1 in `docs/CONTRACTS.md` for why re-seeding requires a
  follow-up fixup) before assuming the agent is wrong.
- A `500` generic error ("The copilot couldn't answer just now...") during any step means an
  unhandled exception in the agent loop, a memory lookup failure, or an empty model reply — check
  CloudWatch logs for the specific `console.error` entry tied to the conversation id and
  timestamp (`docs/RUNBOOK.md` section 8).
- Do not attempt to "fix" a `SAFETY ABORT` error by reconfiguring the POS project URL — it is a
  deliberate guard against ever pointing the agent at a non-staging (e.g. production) Supabase
  project (`docs/RUNBOOK.md` section 6).
