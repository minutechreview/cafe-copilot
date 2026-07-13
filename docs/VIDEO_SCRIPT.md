# Video script — Cafe Copilot (target: under 3:00)

Recording notes: capture the live demo at https://cafe-copilot.pages.dev in a clean browser
window (no bookmarks bar, comfortable zoom, ~16:9). Type at a natural pace — don't rush the
typing, but do cut dead air while the model is still streaming if a response runs long. Voice
is plain and warm, like the copilot itself: no jargon, no hype words.

| Time | Scene / screen action | What to type (verbatim) | Voiceover |
|---|---|---|---|
| 0:00–0:15 | **Cold open hook.** Black screen or a static shot of a cluttered POS dashboard full of numbers, then a hard cut to the Cafe Copilot chat UI, empty and calm. | — | *"Running a small café means a hundred small decisions a day — and most POS software just hands you a wall of numbers and calls it done."* |
| 0:15–0:30 | Chat UI, empty state, suggested-question chips visible. | — | *"Cafe Copilot is a different idea: just ask. It reads your real till data and gives you an honest, plain answer — and it never changes anything in your point-of-sale system."* |
| 0:30–1:00 | Click into the chat, type the question, let the streamed answer play out on screen. | `Why was the drawer short on July 4th?` | *"Ask about a specific day — here, a real cash shortage from the seeded demo café's history — and the answer comes from a live query against the POS, not a guess. Notice the exact figures: what was expected, what was counted, the gap."* |
| 1:00–1:20 | New message in the same conversation. | `Have we had problems with refunds lately?` | *"This one doesn't name a date — the copilot has to search its own memory to find the right day. That's CockroachDB's vector index at work, which we'll come back to."* |
| 1:20–1:35 | New message. | `Who was our best performing staff member this month?` | *"It can compare staff performance and cash accountability too — sorted, real numbers, and it's careful to say refunds were *approved by* someone, never that they personally caused them."* |
| 1:35–1:50 | New message. | `What are we wasting the most money on?` | *"Same for waste and comps — what's being thrown out, why, and roughly what it's costing."* |
| 1:50–2:15 | **The CockroachDB memory moment.** Reload the browser tab fully (hard refresh), then type the next question into what looks like a brand-new session. Optionally cut to a quick look at the `documents` table / a `CREATE VECTOR INDEX ...` statement in the CockroachDB console or `memory/schema.sql` in an editor. | `What did I just ask you?` | *"Here's the part that matters for this hackathon. I just reloaded the page — a brand new browser tab, no history. Watch: it still knows exactly what we talked about. That's not the browser remembering — that's CockroachDB. Every message, every note, and the vector-indexed summaries the copilot searches all live in one CockroachDB cluster, queried live on every turn."* |
| 2:15–2:40 | New message; when the draft card renders, briefly hover/scroll to show the itemized card and the "saved for your review — nothing has been ordered" line. | `Draft a purchase order for 20kg coffee beans and 30L milk` | *"It can also draft things for a human to review — like a purchase order. It's saved, not sent. The copilot never places an order, never writes to the POS — every number and every draft is something a person still has to act on."* |
| 2:40–2:55 | Quick text/graphic overlay (or spoken only) naming the stack — no need to screen-record this part if time is tight. | — | *"Under the hood: Amazon Bedrock runs Claude for the conversation and Titan for the embeddings, deployed on AWS Lambda. CockroachDB is the persistent memory — conversations, notes, drafts, and a vector-indexed history — all in one distributed database."* |
| 2:55–3:00 | Cut back to the calm chat UI, maybe the suggested-question chips. | — | *"Cafe Copilot: ask your till a question, get an honest answer."* |

## 15-second cold-open alternative (pick one)

If a "cluttered dashboard" shot isn't easy to capture, open instead on a single spoken line over
the calm chat UI with the app's title visible:

> *"What if your point-of-sale system could just answer the question you actually have?"*

— then cut straight to 0:15 in the table above.

## Shot list summary (for the person recording)

1. Empty chat UI (title + suggested questions visible) — 0:00–0:30
2. Type + stream: July 4th shortage question — 0:30–1:00
3. Type + stream: refunds question — 1:00–1:20
4. Type + stream: best staff question — 1:20–1:35
5. Type + stream: waste question — 1:35–1:50
6. **Hard reload** the tab, then type the memory-recall question — 1:50–2:05
7. Cutaway: CockroachDB console or `memory/schema.sql`'s `CREATE VECTOR INDEX` line — 2:05–2:15
8. Type + stream: purchase-order draft question, show the draft card — 2:15–2:40
9. Stack recap (voiceover only, or a simple text overlay) — 2:40–2:55
10. Closing line over the calm UI — 2:55–3:00

Publish to YouTube or Vimeo as **public** (per the submission checklist) before linking it in
`docs/SUBMISSION.md` and the Devpost entry.
