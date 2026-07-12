# Codex track status journal (append-only)

(No entries yet. Codex track: append dated, standalone entries here — work done,
verification results, blockers, change requests for docs/CONTRACTS.md.)

## 2026-07-12 — Task 1: staging demo café seed generator

- Done: implemented `demo-seed/seed.mjs` as an authenticated Supabase JS client. It signs up or signs in the demo owner, mirrors setup-wizard business/owner/till/config/menu writes, creates four staff profiles and two tills, and seeds 21 business-local days of completed cash/card orders and line items across dine-in/takeaway/delivery. It records refunds and voids only through `record_order_adjustment`, closes every session through `close_till_session`, and includes paid-in/out, no-sale, waste, ordinary variances, a large-shortage day, and a refund-heavy day. `--fresh` deletes only the authenticated demo owner's existing business before recreating it; default mode refuses an existing demo business. The executable validates the Supabase hostname before auth/network work and accepts only project ref `ljnzschozufepfpkzwjy`.
- Staging verification: `npm run seed -- --fresh` completed against `https://ljnzschozufepfpkzwjy.supabase.co` and created business `5065eeed-8968-4d41-b72b-f2293454addc` for `cafe-copilot-demo@example.com`. `demo-seed/seed-report.json` records 2026-06-22 through 2026-07-12, 21 closed sessions, 339 orders, 461 order items, 11 adjustments, 6 paid-in/out events, 6 no-sales, and 7 waste logs. All 21 close RPC results reconciled to independently calculated expected cash: 0 mismatches, LKR 592,700 expected, LKR 587,560 counted, and LKR -5,140 aggregate variance. The intentional anomaly dates are 2026-07-04 (LKR -4,800 shortage) and 2026-07-08 (4 refunds).
- Additional verification: `npm run seed` refused the existing business and instructed use of `--fresh`. Running with `POS_SUPABASE_URL=https://iveygqneqlsxvdvdxxgx.supabase.co npm run seed -- --fresh` aborted before any request with the staging-only safety error.
- Blockers: none.
