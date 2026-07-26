# CockroachDB Agent Skill release audit

This audit records the second CockroachDB tool used by Café Copilot: Cockroach Labs'
official open-source **Agent Skills Repo**.

## Provenance

- Repository: `cockroachlabs/cockroachdb-skills`
- Skill: `skills/cockroachdb-query-and-schema-design/cockroachdb-sql`
- Audited revision: `e14e86d23ce8ee2e7e40a34ce2944c2502b6eadd`
- Audit date: 2026-07-26
- Scope: `memory/schema.sql`, `memory/migrations/`, `memory/store.mjs`, and their tests
- Connection mode: static review without a live database connection. No `EXPLAIN` result is
  claimed.

## Rules applied

The skill's required CockroachDB rule sets were applied directly:

- Fundamental principles: explicit primary keys, distributed UUID keys, atomic conflict
  handling, and bounded operations.
- Schema design: fixed-width `VECTOR`, JSONB, composite ownership constraints, foreign keys,
  and index structure.
- DML and query patterns: parameterized statements, atomic `INSERT ... SELECT` ownership
  guards, similarity ordering, and explicit limits.
- Optimization: tenant-filter/index alignment and the requirement to validate important
  queries with `EXPLAIN` on a representative live cluster before scaling.

## Verified strengths

- Every table has an explicit UUID primary key generated with `gen_random_uuid()`.
- The embedding column is fixed-width and has a real `CREATE VECTOR INDEX`.
- Every memory operation is parameterized and scoped to the trusted business/principal.
- Dated daily summaries use atomic `INSERT ... ON CONFLICT`, avoiding a select-then-write race.
- Conversation-bound messages and drafts use atomic ownership predicates.
- Retrieval limits are enforced so model input and distributed reads cannot grow without bound.

## Follow-up before large-scale production

Run `EXPLAIN` or `EXPLAIN ANALYZE` for the exact tenant-filtered vector query with
representative per-tenant and total document counts. The current design is appropriate for the
hackathon dataset, but its standalone vector index and `business_id` filter should be measured
before claiming large multi-tenant scale.

Large future backfills should also be batched rather than using a single whole-table update.

## Outcome

The skill found no hackathon-release blocker. It produced one immediate hardening change:
bounded memory and note retrieval. It also converted the tenant-filtered ANN scaling question
into a specific, honest production follow-up instead of an unsupported performance claim.
