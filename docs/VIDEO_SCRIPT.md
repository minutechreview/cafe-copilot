# Video script — Cafe Copilot (target: 3:00, hard cap)

Recording notes: capture the live demo against the **POS staging dashboard**
(`https://phase-8-auth.project-pos.pages.dev`), signed in as the demo owner account and using
the embedded Copilot widget — this is the authoritative, working surface (see
`docs/RUNBOOK.md` section 1 and `docs/DEMO_SCRIPT.md`). Do not use the standalone
`cafe-copilot.pages.dev` build; it is not on the deployed backend's allowed-origin list as of
this writing and will 403. Type at a natural pace — don't rush the typing, but do cut dead air
while the model is still streaming if a response runs long. Voice is plain and warm, like the
copilot itself: no jargon, no hype words.

**Deploy first.** Section 3's refunds question depends on a fix that is not yet on the deployed
Lambda — against the currently deployed function it will ask you for a date range instead of
retrieving the spike, which would lose the single most important beat in this video. Redeploy per
`docs/RUNBOOK.md` section 3 and re-run `docs/DEMO_SCRIPT.md` before you record.

## Section budget (totals exactly 3:00)

| Section | Time | Runs |
|---|---|---|
| 1. The problem | 0:00–0:20 | 20s |
| 2. The live product answering a real question | 0:20–0:45 | 25s |
| 3. The CockroachDB vector-memory moment | 0:45–1:15 | 30s |
| 4. Architecture | 1:15–1:40 | 25s |
| 5. Honesty and safety design | 1:40–2:15 | 35s |
| 6. Memory persistence proof | 2:15–2:45 | 30s |
| 7. Closing line | 2:45–3:00 | 15s |

## Script

| Time | Scene / screen action | What to type (verbatim) | Voiceover |
|---|---|---|---|
| 0:00–0:20 | **Cold open hook.** A static shot of a cluttered POS dashboard full of numbers, then a hard cut to the Cafe Copilot chat widget, closed, sitting calmly in the corner of the POS manager dashboard. | — | *"Running a small café means a hundred small decisions a day — and most POS software just hands you a wall of numbers and calls it done."* |
| 0:20–0:45 | Sign into the POS staging dashboard (or start already signed in to save time), open the manager dashboard, click the floating Copilot button, type the question, let the streamed answer play out. | `Why was the drawer short on July 4th 2026?` | *"Cafe Copilot is a different idea: just ask, right inside your POS. This is a real cash shortage from the seeded demo café's history — the answer comes from a live query against the till, not a guess. Expected versus counted, the exact gap, right there."* |
| 0:45–1:15 | New message in the same conversation. Optionally cut briefly to `memory/schema.sql`'s `CREATE VECTOR INDEX` line or the CockroachDB console's `documents` table while the voiceover explains. | `Have we had any problems with refunds lately?` | *"Here's the part that matters for this hackathon. I didn't say which day — the copilot has to search its own memory to find it. That's CockroachDB: a real vector column and a real vector index on a table of daily summaries, searched by meaning, not keywords. It finds the actual refund spike — four refunds in one day — without me ever naming the date."* |
| 1:15–1:40 | Quick text/graphic overlay of the architecture diagram (browser → Lambda Function URL → Bedrock + CockroachDB + POS Supabase), or spoken only if time is tight. | — | *"Under the hood: the widget talks to a single AWS Lambda over streamed Server-Sent Events. Amazon Bedrock runs Claude for the conversation and Titan for the embeddings. CockroachDB holds every conversation, note, draft, and the vector-indexed summaries. The POS's own database stays the only source of truth for every number — CockroachDB is memory, never arithmetic."* |
| 1:40–2:15 | New message; when the draft card renders, briefly hover/scroll to show the itemized card and the "saved for review — nothing has been ordered" line. | `Draft a purchase order for 20kg coffee beans and 30 litres of milk from Ceylon Supplies` | *"Safety is designed in, not bolted on. This login is a real signed-in owner session, checked against the POS's own access rules — not a public demo mode. Every number the copilot says has to come from a live tool call; it won't invent one. And when it drafts something like a purchase order, it only ever saves it for a human to review — it never places an order, never writes back to the POS."* |
| 2:15–2:45 | **Memory persistence.** Hard-reload the browser tab fully, sign back in if needed, reopen the widget, then type the next question into what looks like a fresh session. | `What did I just ask you?` | *"I just reloaded the page — a new session, no browser history. Watch: it still knows exactly what we talked about. That's not the browser remembering. Every message lives in CockroachDB, queried fresh on every turn, which is also how a saved note — like 'we switch to the winter menu in November' — is still there the next time you ask."* |
| 2:45–3:00 | Cut back to the calm, closed widget over the POS manager dashboard. | — | *"Cafe Copilot: ask your till a question, get an honest answer."* |

## Recording checklist

**Have open / ready:**
- The POS staging dashboard, already signed in as the demo owner. Keep the credential entry
  off-camera; credentials are not committed to the repository.
- The Copilot widget, closed at the start, so opening it is part of the shot.
- Optionally: a code editor open to `memory/schema.sql` (the `CREATE VECTOR INDEX` line) or the
  CockroachDB console's `documents` table, for the section 3 cutaway.
- Optionally: the architecture diagram from `README.md`, as a static image or slide, for section 4.

**Never show on screen, at any point:**
- `.env.local` or any file/terminal output containing an environment variable value.
- The deployed Lambda Function URL — in an address bar, a terminal, `curl` command, or browser
  devtools network tab.
- Any bearer/access token — avoid lingering on the Network tab in devtools; if you must show
  request/response inspection, redact the `Authorization` header first.
- Any AWS CLI profile name, account id, or credentials output.
- The CockroachDB connection string.

Publish to YouTube or Vimeo as **public** (per `docs/SUBMISSION_CHECKLIST.md`) before linking it
in `docs/SUBMISSION.md` and the Devpost entry.

[OWNER TO SUPPLY: hosted video URL, once recorded and uploaded]
