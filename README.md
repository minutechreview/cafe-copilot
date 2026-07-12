# Café Copilot

A plain-language AI assistant for small café owners, built on the open-source Project POS.
Ask "How was today?", "Why was Tuesday's drawer short?", "Which items are wasting money?" —
get honest answers computed from your real till data, plus reviewable drafts (purchase
orders, items-to-watch lists). The copilot never writes to the POS.

Built for the CockroachDB × AWS AI Hackathon: CockroachDB is the agent's persistent memory
(conversations, business context, vector-indexed daily summaries); Amazon Bedrock runs the
model. See docs/CONTRACTS.md for architecture and build coordination.

Status: under construction. Design contract lives in the Project POS repo at
docs/hackathon/COPILOT_DESIGN.md until this repo is self-contained.
