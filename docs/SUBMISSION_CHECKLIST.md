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

## Blocking: deploy before demoing or recording

- [ ] **Rebuild and redeploy the agent Lambda** (`docs/RUNBOOK.md` section 3). The deployed
      function still runs the 2026-07-24 bundle, which predates two fixes verified locally during
      the release-readiness pass: business-local relative-date handling, and the
      `till_sessions` → `staff_profiles` foreign-key change that currently breaks
      `get_staff_performance`. Until this is done, steps 2 and 3 of `docs/DEMO_SCRIPT.md` fail —
      including the flagship CockroachDB vector-search moment.
- [ ] **Re-run `docs/DEMO_SCRIPT.md` end to end against the redeployed function** and confirm each
      expected figure, before recording the video or sharing anything with judges.

## Requires the project owner

Nothing below has been answered on your behalf — each is either a personal/eligibility
attestation, an account action, or media only you can record and host.

### Devpost account and project

- [ ] Create or confirm the Devpost account that will own this submission.
- [ ] Create the project entry on Devpost for the CockroachDB × AWS AI Hackathon.
- [ ] Confirm the hackathon's specific submission deadline and time zone, and submit before it.
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

- [ ] Capture and upload screenshots for the Devpost gallery (e.g. the chat widget mid-answer,
      the purchase-order draft card, the architecture diagram).
- [ ] Confirm image sizes/formats meet Devpost's gallery requirements.

### Repository

- [ ] Confirm the public GitHub repository URL that will be linked from Devpost, and that the
      repository is actually public (not private/internal) by submission time.
- [ ] Confirm `README.md` (owned by a separate agent/track in this session) reflects the same
      corrected demo-access story used in `docs/SUBMISSION.md` and `docs/DEMO_SCRIPT.md` — i.e.
      that the authenticated POS-embedded widget is the supported demo path, not a public
      no-login page — before linking the repo from Devpost.
- [ ] Confirm the license file and any third-party attributions are accurate and complete.

### Hackathon-specific fields

- [ ] Review the CockroachDB × AWS AI Hackathon's Devpost rules page in full and fill in any
      required field not explicitly listed above (e.g. a specific "which sponsor tools did you
      use" checklist, a required tags/category selection, or a specific prize-track opt-in).
- [ ] If the hackathon requires confirmation of which two CockroachDB tools were used, confirm
      the submission form's tool-selection field matches what's written in `docs/SUBMISSION.md`
      (Distributed Vector Indexing; Cloud Managed MCP Server).
- [ ] If AWS credits, sandbox accounts, or a specific AWS account id must be disclosed to the
      judges, supply that separately from the public Devpost text (do not put an AWS account id
      in `docs/SUBMISSION.md`).

### Final pre-submit check

- [ ] Re-read `docs/SUBMISSION.md` once all `[OWNER TO SUPPLY: ...]` placeholders are filled in,
      to confirm nothing sensitive was pasted into a public-facing field by mistake.
- [ ] Confirm the live demo path in `docs/DEMO_SCRIPT.md` still works end to end immediately
      before judging opens (accounts, memberships, and rate limits can all change between when
      this was written and when a judge actually tries it).
