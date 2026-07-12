# Claude track status journal (append-only)

## 2026-07-12 — repo bootstrapped
Scaffolded: LICENSE (MIT), README stub, docs/CONTRACTS.md (interface contracts + git
protocol for the dual-orchestrator build), directory skeleton (web/ agent/ memory/ owned by
Claude track; pos-sync/ demo-seed/ owned by Codex track), STATUS journals. .env.local holds
verified CRDB + AWS credentials (gitignored). CockroachDB cluster + vector indexing verified
live (CREATE VECTOR INDEX works); Bedrock access verified (121 models visible). Next on this
track: C1 app scaffold (chat UI shell, Lambda-ready agent backend, Bedrock echo round-trip)
via delegated Sonnet builder.

## 2026-07-12 — C1 scaffold done (one pending external gate)
web/ (Vite+React chat), agent/ (handler.mjs on Bedrock Converse, dev-server.mjs,
find-model.mjs → BEDROCK_MODEL_ID=us.anthropic.claude-sonnet-4-5-20250929-v1:0 validated by
1-token probes), memory/ placeholder. 4/4 unit tests, lint clean, web build clean. Real
Bedrock connectivity proven twice, BUT full end-to-end chat is gated by an AWS account
requirement: the owner must submit the "Anthropic use case details" form in the Bedrock
console (Model access page); until then Converse calls intermittently return the
use-case-form error. After the form: re-run `node agent/scripts/find-model.mjs` (the account
catalog also shows newer Sonnet 5 ids — pick up the newest invokable), then prove the
end-to-end curl. Next Claude-track phase: C2 (CockroachDB memory schema + persistence).
