# Café Copilot — Operations Runbook

This is an operator's guide to running, deploying, and troubleshooting the Café Copilot
backend. It is derived from the code in this repository as of the date this file was written,
not from the README, which may be out of date in places. Every claim below is either verified
against the source files listed at the end of each section, or flagged explicitly in
[section 10](#10-needs-operator-confirmation).

## 1. System map

| Component | What it is | Role |
|---|---|---|
| POS staging dashboard (Supabase-backed web app) | Browser client | **The authoritative demo surface.** Embeds the Café Copilot chat widget in `authenticated` mode, using a real Supabase owner/manager session against the POS staging project. |
| Standalone Cloudflare Pages site (`cafe-copilot.pages.dev`) | Browser client | A second, independent static build of the same chat UI. As of today it is **not** on the deployed Lambda's allowed-origin list, so requests from it are rejected with `403 Origin is not allowed.` (verified live). Treat it as non-functional against the current deployment until an operator adds its origin. |
| AWS Lambda Function URL | Compute | Runs `agent/lambda.mjs`, invoked in `RESPONSE_STREAM` mode. Terminates CORS/origin checks, rate limiting, and the request deadline, then streams Server-Sent Events back to whichever browser client called it. |
| Amazon Bedrock | Model host | Claude (Converse Stream API) for the chat/tool loop; Titan Text Embeddings v2 (or a configured alternative) for `search_memory` and the backfill script. |
| CockroachDB | Memory store | `conversations`, `messages`, `notes`, `drafts`, `documents` (vector-indexed). This is context and retrieval only — it is never the source of a sales/cash/staff number. |
| Supabase (POS staging project, ref `ljnzschozufepfpkzwjy`) | System of record | Read-only source for orders, tills, staff performance, and waste; also the identity provider (Supabase Auth JWTs) and authorization source (`business_memberships` table) for `authenticated` mode. |

Request flow for the authoritative surface: POS dashboard → Lambda Function URL (SSE) →
Bedrock (Converse stream) + CockroachDB (memory) + POS Supabase (read-only tool calls) →
streamed deltas back to the dashboard.

Source: `agent/lambda.mjs`, `agent/handler.mjs`, `agent/auth-context.mjs`, `agent/pos-client.mjs`, `README.md` (architecture diagram, cross-checked against code).

## 2. Environment variables

All names below are read directly from `process.env` somewhere in `agent/` or `memory/`.
Values are never shown here or anywhere in this document.

### Read by the deployed Lambda (via `agent/lambda.mjs` → `agent/handler.mjs` → `agent/tools.mjs` → `memory/store.mjs`)

| Variable | Controls | Required? | Default / limit enforced in code |
|---|---|---|---|
| `AWS_REGION` | Region for the Bedrock client. | Required for Bedrock calls to succeed. | No default. On Lambda this is supplied automatically by the runtime and cannot be overridden by an environment variable of the same name; set it only for local dev. |
| `CRDB_CONNECTION_STRING` | CockroachDB connection string for the memory pool. | Required. | Throws immediately if unset or blank. |
| `CRDB_POOL_MAX` | Max pool connections. | Optional. | Default 4, must be a positive integer ≤ 10. |
| `CRDB_CONNECTION_TIMEOUT_MS` | Pool connection timeout. | Optional. | Default 5000, max 10000. |
| `CRDB_IDLE_TIMEOUT_MS` | Pool idle timeout. | Optional. | Default 10000, max 60000. |
| `CRDB_QUERY_TIMEOUT_MS` | Per-query timeout. | Optional. | Default 10000, max 30000. |
| `CRDB_STATEMENT_TIMEOUT_MS` | Per-statement timeout. | Optional. | Default 10000, max 30000. |
| `BEDROCK_MODEL_ID` | Chat model id for Converse Stream. | Required. | Handler throws `BEDROCK_MODEL_ID is not configured` if unset. |
| `BEDROCK_MAX_TOKENS` | Max output tokens per model call. | Optional. | Default 700, must be a positive integer ≤ 2000. |
| `BEDROCK_EMBEDDING_MODEL_ID` | Embedding model id for `search_memory` and backfill. | Required only when an embedding call actually happens. | Throws `BEDROCK_EMBEDDING_MODEL_ID is not configured` if unset at call time. |
| `EMBEDDING_DIM` | Requested embedding dimensionality (Titan-shaped requests only). | Optional. | If unset, the dimension/normalize fields are simply omitted from the Bedrock request. |
| `DEMO_BUSINESS_ID` | Business id used for legacy/demo-mode principals. | Optional. | Defaults to the literal `demo-cafe`. |
| `POS_SUPABASE_URL` | POS Supabase project URL. | Required. | Must resolve to exactly `https://ljnzschozufepfpkzwjy.supabase.co`, HTTPS, no embedded credentials, no non-default port — anything else throws a `SAFETY ABORT` error (see `agent/pos-client.mjs:assertStagingUrl`). |
| `POS_SUPABASE_ANON_KEY` | POS Supabase anon key, used with the caller's JWT or the demo sign-in. | Required. | Throws if unset when a POS client is created. |
| `DEMO_OWNER_EMAIL` / `DEMO_OWNER_PASSWORD` | Credentials used to sign in the shared demo Supabase client (`mode: "demo"` only). | Required only if demo mode is used. | `agent/pos-client.mjs` throws if either is unset when demo sign-in runs — it does **not** contain a hardcoded fallback itself (a fallback literal exists in the separate `demo-seed/seed.mjs` and `pos-sync/cli.mjs` scripts, not in the agent). |
| `DEMO_MODE_ENABLED` | Whether `mode: "demo"` requests are served at all. | Effectively required — treated as disabled unless exactly `"true"`. | Any value other than the string `"true"` returns `403 "Demo access is not available."`. Confirmed live: currently not `"true"` on the deployed function. |
| `WEB_ORIGIN` | Primary allowed browser origin for CORS/origin checks. | Required by the deploy script (`configuredCorsOrigins` throws if no origin is configured at all). | No default. |
| `COPILOT_ALLOWED_ORIGINS` | Comma-separated additional allowed origins. | Optional. | Empty string if unset. |
| `COPILOT_REQUEST_TIMEOUT_MS` | Per-request deadline before a `504` is returned and the Bedrock/DB calls are aborted. | Optional. | Default 50000, max 54000. |
| `COPILOT_RATE_LIMIT_MAX_REQUESTS` | Requests allowed per IP per window before `429`. | Optional. | Default 20, max 1000. |
| `COPILOT_RATE_LIMIT_WINDOW_MS` | Rate-limit window length. | Optional. | Default 60000, max 3,600,000. |
| `COPILOT_MAX_INPUT_CHARS` | Max characters accepted in the `message` field. | Optional. | Default and max both 12,000. |
| `COPILOT_MAX_BODY_BYTES` | Max raw request body size before `413`. | Optional. | Default 20,000, max 100,000. |
| `COPILOT_LOCALE_OFFSETS` | JSON object of locale/timezone offsets used when resolving a business's local date. | Optional. | Must be valid JSON representing a plain object if set; throws otherwise. |
| `COPILOT_RESERVED_CONCURRENCY` | Target reserved concurrency applied by the deploy script (not read by the running function itself). | Required at deploy time. | Must be a positive integer ≤ 10 (`agent/scripts/deploy-lambda.mjs`). Confirmed live: currently 2. |
| `COPILOT_DEPLOYMENT_LOCK_TOKEN` | Internal fencing-lock token written into the function's own environment during a deploy. | Not operator-set. | Managed entirely by `agent/deployment-lock.mjs`; never set this by hand (see section 3). |

### Additional variables read only by the local dev server (`agent/dev-server.mjs`), not by Lambda

| Variable | Controls | Default |
|---|---|---|
| `PORT` | Local HTTP port for `node dev-server.mjs`. | 8787 |
| `WEB_ORIGIN` | Also used here as the sole allowed CORS origin if `COPILOT_ALLOWED_ORIGINS` is unset. | `http://localhost:5173` |

Source: `agent/lambda.mjs`, `agent/dev-server.mjs`, `agent/handler.mjs`, `agent/tools.mjs`, `agent/pos-client.mjs`, `agent/auth-context.mjs`, `agent/embeddings.mjs`, `memory/store.mjs`, `agent/scripts/deploy-lambda.mjs` (`LAMBDA_ENV_KEYS`, `assertDeploySafetyConfiguration`).

## 3. Deploy procedure

Run from the repository root unless noted.

Build the deployable bundle (esbuild output + zip):

```bash
npm run bundle --workspace=agent
```

Deploy (idempotent — safe to re-run):

```bash
npm run deploy-lambda --workspace=agent
```

What the deploy script does, in order (`agent/scripts/deploy-lambda.mjs`):

1. Validates that every safety-relevant environment variable in `.env.local` is present and in
   range (`assertDeploySafetyConfiguration`) — refuses to deploy otherwise.
2. Resolves the AWS account id and ensures the `cafe-copilot-agent-role` IAM execution role
   exists, attaching an inline policy scoped to `bedrock:InvokeModel` /
   `bedrock:InvokeModelWithResponseStream` and this function's own CloudWatch Logs group only.
3. Reads the pre-built `agent/dist-lambda/function.zip` — it does **not** bundle for you; the
   `bundle` step above must run first, every time.
4. If the function already exists, guards the update:
   - Acquires a **fencing lock**: a compare-and-swap write of `COPILOT_DEPLOYMENT_LOCK_TOKEN`
     into the function's own environment variables, gated on Lambda's `RevisionId`. If another
     deploy already holds the lock, this fails closed with an error rather than proceeding.
   - Sets reserved concurrency to **0**.
   - Updates function code, then function configuration (role, handler, runtime, memory,
     timeout, environment variables including the lock token), waiting for each to reach a
     successful terminal state before continuing.
   - Restores reserved concurrency to `COPILOT_RESERVED_CONCURRENCY`.
   - Releases the lock (removes the token) in a `finally` block regardless of outcome.
5. If the function does not exist yet, creates it (trying `nodejs22.x` then falling back to
   `nodejs20.x`), then sets reserved concurrency directly — no lock is needed because there is
   no existing public capacity to protect.
6. Creates or updates the public Function URL (`RESPONSE_STREAM` invoke mode, CORS restricted
   to `WEB_ORIGIN` + `COPILOT_ALLOWED_ORIGINS`) and ensures the public invoke permissions
   (`lambda:InvokeFunctionUrl` and, separately, `lambda:InvokeFunction`) are attached.

**What a crashed deploy leaves behind, and how to recover:**

- If the process dies after the lock is acquired but before it is released, the function is
  left at **reserved concurrency 0** (no traffic served) with `COPILOT_DEPLOYMENT_LOCK_TOKEN`
  still set in its environment. This is deliberate: an unattended second deploy must not be
  able to silently restore capacity while the first one might still be running.
- Recovery is a manual, deliberate act, not something the tooling automates:
  1. Confirm the original deploy process is actually dead (check the machine/CI job that ran
     it — do not guess from the Lambda side alone).
  2. Only then clear `COPILOT_DEPLOYMENT_LOCK_TOKEN` from the function's environment variables
     and restore `ReservedConcurrentExecutions` to the intended value, or simply re-run
     `npm run deploy-lambda --workspace=agent` — a fresh deploy attempt on an existing function
     with no lock held will acquire the lock, redo the update, and restore concurrency itself.
  3. Do not run a second deploy concurrently with a possibly-still-running first one — the lock
     exists specifically to prevent that race.

Source: `agent/scripts/deploy-lambda.mjs`, `agent/deployment-order.mjs`, `agent/deployment-lock.mjs`, `agent/lambda-update-waiter.mjs`.

## 4. Rollback

**Verified from code:** `agent/scripts/deploy-lambda.mjs` creates and updates the function with
`Publish: false` (create) and never calls a publish-version API on update. That means this
tooling does **not** maintain numbered Lambda versions to roll back between — every deploy
overwrites `$LATEST` in place. There is no "revert to version N" command available today.

Practical rollback with the current tooling:

1. Identify the last known-good commit for the agent code (`git log` in this repo).
2. Check out or worktree that commit (or apply the inverse diff) without disturbing the current
   branch's uncommitted work.
3. Rebuild and redeploy from that code:
   ```bash
   npm run bundle --workspace=agent
   ```
   ```bash
   npm run deploy-lambda --workspace=agent
   ```
4. Return to the current branch/commit once the rollback deploy has completed and been verified
   (see section 5, Health checks).

**What redeploying does NOT roll back:**

- **CockroachDB rows.** Conversations, messages, notes, drafts, and documents already written
  are untouched by any Lambda deploy or rollback — the database and the compute layer are
  fully independent.
- **Applied migrations.** `memory/migrate.mjs` records applied migrations in a
  `schema_migrations` ledger and only ever runs files forward — there is no down-migration
  mechanism in this codebase. Migrations here are **forward-only**: if a migration needs to be
  undone, that requires writing and running a new forward migration that reverses the effect,
  not reverting code.
- **POS staging data.** Anything the copilot saved to CockroachDB, or any state in the POS
  Supabase project itself, is entirely outside the Lambda deploy/rollback boundary.

Source: `agent/scripts/deploy-lambda.mjs`, `memory/migrate.mjs`, `memory/migrations/` (contains only forward files, no down/rollback files).

## 5. Health checks

These probes only exercise guard-rail code paths — none of them reach Bedrock or CockroachDB,
so they cost no model tokens and touch no data. Replace `<FUNCTION_URL>` with the deployed
Lambda Function URL.

Confirms the function is reachable and its Content-Type guard is live (expect `400`):

```bash
curl -i -X POST <FUNCTION_URL>
```

Confirms the CORS/origin guard is live and rejects an unexpected origin (expect `403`):

```bash
curl -i -X POST <FUNCTION_URL> -H "Content-Type: application/json" -H "Origin: https://example.invalid" -d "{}"
```

Confirms the origin guard passes for the real allowed origin and the request then fails on
`mode` validation instead (expect `400`, not `403` — proves the CORS allowlist actually
contains the POS staging origin):

```bash
curl -i -X POST <FUNCTION_URL> -H "Content-Type: application/json" -H "Origin: <ALLOWED_ORIGIN>" -d "{}"
```

Confirms demo mode's current on/off state (expect `403 \"Demo access is not available.\"` while
`DEMO_MODE_ENABLED` is not `"true"`; a `400` about `businessId`/auth instead would mean demo mode
has since been turned on and the response is now hitting authenticated-path validation — check
`DEMO_MODE_ENABLED` if that happens):

```bash
curl -i -X POST <FUNCTION_URL> -H "Content-Type: application/json" -H "Origin: <ALLOWED_ORIGIN>" -d "{\"message\":\"ping\",\"mode\":\"demo\"}"
```

What each result proves:

| Probe | Proves |
|---|---|
| No headers, no body | The Function URL is deployed and invocable, and the Content-Type check runs before anything else (including CORS in this codepath's ordering — see `assertSafeBrowserRequest`). |
| Disallowed `Origin` | The CORS allowlist is enforced and does not accidentally allow arbitrary origins. |
| Allowed `Origin`, empty body | The allowlist correctly includes the real origin, and validation continues past CORS into body/mode checks. |
| `mode: "demo"` | Whether demo access is currently enabled, without spending a model call either way. |

Source: `agent/lambda.mjs` (`assertSafeBrowserRequest`, `parseRequestPayload`), `agent/handler.mjs` (`resolveTrustedChatInput` mode validation), live verification described in the task context.

## 6. Failure playbook

| Symptom | Likely cause | First action |
|---|---|---|
| `400` "Content-Type must be application/json." | Missing/incorrect `Content-Type` header, or client sending non-JSON body. | Check the calling client's request headers; this is enforced before any other logic runs. |
| `403` "Origin is not allowed." | Caller's `Origin` header is not in `WEB_ORIGIN` + `COPILOT_ALLOWED_ORIGINS`. | Confirm which origin is calling and whether it's supposed to be allowed; update `COPILOT_ALLOWED_ORIGINS` and redeploy if it should be. |
| `403` "Demo access is not available." | `DEMO_MODE_ENABLED` is not exactly `"true"`. | Confirm intent — demo mode may be deliberately off. Do not flip it on without operator sign-off. |
| `401` "Invalid or expired authentication token." | Missing/malformed/expired Supabase bearer token. Supabase access tokens last 1 hour. | Ask the caller to re-authenticate (refresh the session) in the POS dashboard. |
| `403` "Access denied: active owner or manager membership required." | The authenticated user has no active `owner`/`manager` row in `business_memberships` for the requested `businessId`. | Verify the user's membership role/status in the POS staging project directly; this is not something the agent can grant. |
| `413` "Request body is too large." | Body exceeds `COPILOT_MAX_BODY_BYTES` (default 20,000 bytes). | Check what the client sent; if legitimately larger, raise the limit deliberately and redeploy — do not raise it reactively without understanding why the payload grew. |
| `429` "Too many Copilot requests..." | Caller exceeded `COPILOT_RATE_LIMIT_MAX_REQUESTS` within `COPILOT_RATE_LIMIT_WINDOW_MS`, **on the specific warm Lambda instance that served them** (see section 7 — this is not a global limit). | Wait for the window to elapse; if this is happening to legitimate traffic, it may mean many concurrent cold-started instances are each independently under-limiting — treat as a signal to review traffic patterns, not just raise the number. |
| `504` "The Copilot request took too long." | The whole request exceeded `COPILOT_REQUEST_TIMEOUT_MS` (default 50s, hard max 54s just under the Lambda response-stream ceiling). | Check Bedrock and CockroachDB latency/availability for that time window; this is not adjustable per-request. |
| `500` generic error ("The copilot couldn't answer just now...") | Catch-all: unhandled exception in the agent loop, memory lookup failure, or empty Bedrock reply. | Check Lambda logs for the specific `console.error` entry (see section 8) tied to the request's `conversationId` and timestamp. |
| Empty SSE stream (connection opens, no `data:` events, then closes) | Handler resolved without ever calling `onEvent` — treated in code as a should-not-happen case that still returns a `500` JSON body rather than hanging the client. | Check logs for `[agent] Bedrock returned an empty reply` or a memory-lookup failure; this indicates a logic bug, not normal load behavior. |
| `SAFETY ABORT: staging ljnzschozufepfpkzwjy.supabase.co required...` | `POS_SUPABASE_URL` does not resolve to exactly the POS staging project (wrong hostname, non-HTTPS, embedded credentials, or non-default port). | **Do not work around this.** It is an intentional guard against ever pointing the agent at a non-staging (e.g. production) Supabase project. Fix the configured URL; never bypass the check. |

Source: `agent/lambda.mjs`, `agent/handler.mjs`, `agent/auth-context.mjs`, `agent/pos-client.mjs` (`assertStagingUrl`), live verification described in the task context.

## 7. Cost and abuse controls

All of the following are enforced in code today:

- **Reserved concurrency**: capped (confirmed live at 2) via `COPILOT_RESERVED_CONCURRENCY`,
  enforced by `PutFunctionConcurrencyCommand` in the deploy script — bounds the maximum
  simultaneous Lambda executions regardless of incoming request volume.
- **Per-IP rate limit**: `COPILOT_RATE_LIMIT_MAX_REQUESTS` requests per
  `COPILOT_RATE_LIMIT_WINDOW_MS` window, keyed by source IP.
  **This limiter's state (`rateLimitWindows`) is an in-memory `Map` local to one warm Lambda
  instance.** It is per-instance, not global or shared across concurrent executions or cold
  starts. With reserved concurrency at 2, the practical ceiling for one IP is therefore up to
  roughly `2 ×` the configured per-instance limit, not a hard global cap. State plainly: this is
  not a substitute for a shared/global rate limiter (e.g. one backed by CockroachDB or an
  external store), and should not be assumed to be one.
- **Request deadline**: `COPILOT_REQUEST_TIMEOUT_MS` aborts the in-flight Bedrock call and
  database operations via an `AbortController`, bounding worst-case compute time per request.
- **Max body bytes**: `COPILOT_MAX_BODY_BYTES` rejects oversized request bodies before parsing.
- **Max input characters**: `COPILOT_MAX_INPUT_CHARS` bounds the `message` field length,
  independent of body size.
- **Bedrock max tokens**: `BEDROCK_MAX_TOKENS` bounds model output length per Converse call.
- **Agent loop iteration cap**: `MAX_ITERATIONS = 6` in `agent/handler.mjs` (not
  environment-configurable) bounds how many tool-call round trips a single turn can make before
  the loop is forced to stop and error out.

Source: `agent/lambda.mjs`, `agent/handler.mjs`, `agent/scripts/deploy-lambda.mjs`.

## 8. Observability

- **Where logs go**: standard Lambda behavior — everything written via `console.log` /
  `console.error` in the function goes to the function's CloudWatch Logs group
  (`/aws/lambda/cafe-copilot-agent`, per the inline IAM policy scope in
  `agent/scripts/deploy-lambda.mjs`).
- **What is logged**: every `console.error` call in `agent/handler.mjs`, `agent/lambda.mjs`, and
  `agent/dev-server.mjs` logs a short label (e.g. `[agent] tool call failed`), plus a small
  structured object typically containing `conversationId`, the failing tool's `name`, and
  `error: err?.message ?? String(err)` — i.e. the error's message text, not a stack trace or raw
  exception object, and not the request body or model output. `agent/lambda.mjs`'s top-level
  catch also logs the resolved `statusCode`.
- **Confirmed from code: nothing sensitive is logged.** No log statement in these three files
  includes a bearer token, access token, password, the raw `message` content, or a full request
  body. Error messages logged from `AuthContextError`/auth failures are the same user-safe
  strings returned to the client (e.g. "Invalid or expired authentication token."), not upstream
  provider errors.
- **This logging is structured but sparse.** There is no request-id/trace-id correlation beyond
  `conversationId` (which is absent for failures that happen before a conversation is
  created/resolved), no log line marking the *start* of a request, and no timing/latency
  metrics logged anywhere. Recommended improvements, not yet implemented:
  - Log a single line per request on entry (method, mode, resolved businessId or "unknown")
    with a generated request id, and include that id in every subsequent log line for the same
    request, so a CloudWatch Logs Insights query can reconstruct one request's full timeline.
  - Log elapsed time for the Bedrock call and for each tool call, to make `504`s and slow tool
    calls diagnosable without guessing from wall-clock log timestamps alone.
  - Emit a structured (JSON) log line rather than a message string + object, so CloudWatch
    Logs Insights can filter/aggregate on fields like `statusCode` or `tool` directly.

Source: `agent/lambda.mjs`, `agent/handler.mjs`, `agent/dev-server.mjs`, `agent/auth-context.mjs`.

## 9. Incident response

Ordered checklist for "the copilot is misbehaving in front of an audience" (giving wrong
answers, leaking odd content, or otherwise behaving unacceptably during a live demo):

1. **Least destructive first — stop new traffic without touching data.** Set reserved
   concurrency to 0 so no new invocations start:
   ```bash
   aws lambda put-function-concurrency --function-name cafe-copilot-agent --reserved-concurrent-executions 0
   ```
   This is reversible in seconds (restore the prior value with the same command) and touches
   no data, no code, and no credentials.
2. **If that's not enough, disable the Function URL's public invoke rather than deleting
   anything.** Removing the `lambda:InvokeFunctionUrl` / `lambda:InvokeFunction` resource-policy
   statements (or deleting the Function URL config) stops all traffic outright; recreating it
   afterward is the same idempotent step the deploy script already performs
   (`ensureFunctionUrl`, `ensurePublicInvokePermission`), so this is recoverable but slightly
   more involved than step 1 — try step 1 first.
3. **Who/what is affected**: only the Café Copilot Lambda and its callers (the POS dashboard
   widget and the standalone Cloudflare Pages site) are affected by either of the above. The POS
   application itself, its Supabase project, and CockroachDB are all read from, not written to
   in a way that either lever touches — stopping the Lambda does not protect or endanger POS
   staging data.
4. **Never do these in a hurry, mid-incident, without a deliberate decision:**
   - Touch production POS in any way — this system only ever reads POS **staging**
     (`assertStagingUrl` exists specifically to make pointing it at production impossible by
     accident; do not "fix" a problem by relaxing that check).
   - Apply a CockroachDB migration — migrations here are forward-only (section 4); an
     incident is not the moment to introduce an unreviewed schema change.
   - Rotate credentials (Supabase anon key, demo owner password, CockroachDB connection string)
     mid-demo — a credential rotation requires a coordinated Lambda environment update and
     redeploy (section 3), and doing it under time pressure risks a half-updated, broken
     configuration in front of the same audience you're trying to protect.
5. Once traffic is stopped, diagnose calmly using section 6 (Failure playbook) and section 8
   (Observability) before deciding on a fix, and only then redeploy (section 3) or roll back
   (section 4) deliberately.

Source: `agent/scripts/deploy-lambda.mjs` (`setConcurrency`, `ensureFunctionUrl`,
`ensurePublicInvokePermission`), `agent/pos-client.mjs` (`assertStagingUrl`), `memory/migrate.mjs`.

## 10. Needs operator confirmation

- **Whether the standalone Cloudflare Pages origin (`cafe-copilot.pages.dev`) is intended to be
  added to `COPILOT_ALLOWED_ORIGINS`, or is deliberately excluded.** The code and today's live
  test both show it is currently rejected; I could not find anything in the repo stating which
  of these is the intended end state.
- **The exact current value of `COPILOT_RESERVED_CONCURRENCY`, `COPILOT_RATE_LIMIT_MAX_REQUESTS`,
  and the other tunable guardrails on the live deployed function**, beyond the specific
  live-verified facts given to me (concurrency 2; demo mode off). I can state the defaults and
  enforced ranges from code, but not today's actual configured values for variables I wasn't
  given a live-verified number for — this document deliberately avoids guessing them.
- **Whether any Lambda function versions have ever been published outside of this repo's own
  tooling** (e.g. manually via the AWS console or CLI, outside `deploy-lambda.mjs`). The
  deploy script itself never publishes a version (`Publish: false`, no publish call on update),
  but I cannot rule out an out-of-band manual publish having happened at some point; if one
  exists, `aws lambda list-versions-by-function` would reveal it and could offer a real
  rollback target that this document doesn't currently assume exists.
- **Whether CloudWatch Logs retention/alerting is configured at all for this function's log
  group.** Nothing in this repository's IAM policy or deploy script sets a retention period or
  alarm; I could not verify either way whether one has been configured separately in the AWS
  console.
- **Who has authority to run the incident-response levers in section 9** (i.e. who holds AWS
  credentials with `lambda:PutFunctionConcurrency` / `lambda:UpdateFunctionUrlConfig` on this
  function) during a live demo. This is an operational/organizational fact, not something
  derivable from the code.
- **The intended production posture for `DEMO_MODE_ENABLED`.** It is off today; whether that is
  the long-term intended state or a temporary condition ahead of a specific demo is not stated
  anywhere in the repository.
