# Submission checklist — Cafe Copilot

Built for the **CockroachDB × AWS AI Hackathon**. Split into what is verified done in this
repository, and what only the project owner can complete (personal attestations, account
actions, and media the owner must record/host).

## Verified done

- [x] `docs/SUBMISSION.md` — Devpost-ready draft covering project name, tagline, inspiration,
      what it does, how we built it (CockroachDB first, then AWS), challenges, accomplishments,
      what we learned, what's next, CockroachDB AI-tools feedback, and an honest disclosures
      section.
- [x] `docs/DEMO_SCRIPT.md` — reproducible demo journey with exact click path, exact questions in
      order, what each proves, expected real figures, and a fallback note per step.
- [x] `docs/VIDEO_SCRIPT.md` — a script timed to exactly 3:00 across seven sections (problem,
      live product, CockroachDB vector-memory moment, architecture, honesty/safety design,
      memory persistence, closing), plus a recording checklist of what to show and what to hide.
- [x] Core product claims verified against source and/or live behavior before being written into
      the docs above: tool names and system-prompt rules (`agent/handler.mjs`,
      `agent/tools.mjs`), authenticated-mode auth flow (`agent/auth-context.mjs`), CockroachDB
      schema and vector search (`memory/store.mjs`, `memory/verify.mjs`), and the CockroachDB
      Cloud health probe (`ops/crdb-health.mjs`).
- [x] Current operational state cross-checked against `docs/RUNBOOK.md` (read-only) rather than
      assumed from the older README draft — in particular, that public no-login demo mode is
      currently disabled and the standalone Cloudflare Pages build is not on the deployed
      backend's allowed-origin list, so the docs above describe the POS-embedded authenticated
      widget as the demo path, not a public URL.
- [x] No secret values, connection strings, API keys, or the deployed Lambda Function URL
      appear in any of the four files above.
- [x] Every field Devpost requires that depends on a personal, eligibility, or account-level fact
      is left as an explicit `[OWNER TO SUPPLY: ...]` placeholder rather than answered on the
      owner's behalf (full list in the report accompanying this task).

## Deployment and live verification

- [x] **Rebuilt and redeployed the agent Lambda** on 2026-07-26 with business-local date
      handling, the corrected staff relationship, and anti-speculation prompt rules.
- [x] **Re-ran the core demo journey against the embedded staging widget**: cash reconciliation,
      refund vector-memory retrieval, staff performance, waste, purchase-order draft, and
      conversation recall after a hard reload all passed. The authenticated PostgREST
      relationship smoke, 202 tests, lint, and production build also passed.

## Requires the project owner

Nothing below has been answered on your behalf — each is either a personal/eligibility
attestation, an account action, or media only you can record and host.

### Devpost account and project

- [x] Confirmed the authenticated Devpost account is registered for the hackathon.
- [x] Created the non-submitted **Cafe Copilot** project draft:
      `https://devpost.com/software/cafe-copilot`.
- [x] Confirmed from the live Devpost form on 2026-07-26: submissions close
      **2026-08-18 at 5:00 PM EDT** (`2026-08-18T21:00:00Z`).
- [ ] Fill in the project's Devpost **start date** field (placeholder left in
      `docs/SUBMISSION.md` under "Team and eligibility").
- [ ] Add **team member(s)** to the Devpost project and to `docs/SUBMISSION.md` (placeholder
      left in the same section).
- [ ] Confirm **country of residence / eligibility** for each team member, per the hackathon's
      official rules (placeholder left in `docs/SUBMISSION.md`).
- [ ] Confirm **age / age-eligibility**, if the hackathon rules require it (placeholder left in
      `docs/SUBMISSION.md`).
- [ ] Disclose any **affiliation** the hackathon rules require (employer, school, prior
      relationship to CockroachDB, AWS, or Devpost) (placeholder left in `docs/SUBMISSION.md`).
- [ ] Complete the hackathon's **AI-tool usage disclosure**, if one is required by the rules
      (placeholder left in `docs/SUBMISSION.md`) — this submission package itself was drafted
      with AI assistance, which the owner should factor into that disclosure.

### Video

- [ ] Record the video following `docs/VIDEO_SCRIPT.md` (3:00 hard cap), using the recording
      checklist in that file to confirm nothing sensitive is visible on screen.
- [ ] Upload the video to YouTube or Vimeo as **public** (or "unlisted" only if the hackathon
      rules explicitly permit it — confirm this first).
- [ ] Add the hosted video URL to `docs/SUBMISSION.md` (placeholder under "Try it out") and to
      the Devpost project's video field.

### Screenshots and media

- [x] Prepared `docs/media/copilot-refund-memory.jpg`, captured from the verified authenticated
      staging widget, plus `docs/media/cafe-copilot-architecture.svg` and its
      gallery-ready PNG export.
- [ ] Upload the selected media to the Devpost gallery and confirm its current image
      size/format requirements.

### Repository

- [x] Confirmed `https://github.com/minutechreview/cafe-copilot` is public and linked from the
      Devpost draft.
- [x] Confirmed `README.md`, `docs/SUBMISSION.md`, and `docs/DEMO_SCRIPT.md` consistently use
      the authenticated POS-embedded widget as the supported demo path.
- [x] Confirmed the repository contains an MIT `LICENSE` and GitHub detects it as MIT.

### Hackathon-specific fields

- [x] Reviewed the live Devpost submission requirements and judging criteria on 2026-07-26.
      Required technical fields are functional demo URL, public repository URL, license URL,
      two CockroachDB tools, at least one AWS service, and a meaningful-integration explanation.
- [x] The two evidenced CockroachDB tools in the submission are **Distributed Vector Indexing**
      and **Agent Skills Repo**. The AWS selections are **Amazon Bedrock** and **AWS Lambda**.
- [ ] If AWS credits, sandbox accounts, or a specific AWS account id must be disclosed to the
      judges, supply that separately from the public Devpost text (do not put an AWS account id
      in `docs/SUBMISSION.md`).

### Final pre-submit check

- [ ] Re-read `docs/SUBMISSION.md` once all `[OWNER TO SUPPLY: ...]` placeholders are filled in,
      to confirm nothing sensitive was pasted into a public-facing field by mistake.
- [ ] Confirm the live demo path in `docs/DEMO_SCRIPT.md` still works end to end immediately
      before judging opens (accounts, memberships, and rate limits can all change between when
      this was written and when a judge actually tries it).
