# AutoPilot — Backend

A personal automation platform. AutoPilot exposes a provider-agnostic HTTP API that
runs automations on demand or on a schedule, records what happened, and notifies you.

Naukri profile update is the first automation. It is **not** the architecture —
Naukri is one worker plugged into an engine that treats LinkedIn, GitHub, Indeed and
resume upload as equals.

---

## Architecture

```
HTTP request
    │
    ▼
Route ─────────────► Zod validation (provider enum derived from the registry)
    │
    ▼
Controller ────────► no provider names, no automation logic
    │
    ▼
AutomationService ─► execution id · time budget · timing · logging · error mapping
    │                (Phase 4: history persistence · Phase 5: notifications)
    ▼
Provider Registry ─► ProviderId → lazy worker factory
    │
    ▼
AutomationWorker ──► NaukriWorker | LinkedInWorker | GitHubWorker | …
    │                (Phase 3: Playwright lives here and nowhere else)
    ▼
Playwright / DB / Notifications
```

### The load-bearing decisions

**Provider registry, not a `switch`.** [`provider.registry.ts`](src/automation/provider.registry.ts)
maps provider IDs to lazy worker factories. The set of supported providers is _data_,
so request validation reads from the same source as the factory and the two cannot
drift. Adding LinkedIn is one new file plus one line in the registry — no controller,
route, service or schema change.

**Domain vocabulary vs. reality.** `PROVIDER_IDS` in [`types.ts`](src/automation/types.ts)
lists every provider AutoPilot knows about; the registry holds only the ones that are
implemented. An unimplemented provider is rejected at the edge with a message naming
what _is_ available.

**Lazy worker construction.** Workers are created per execution via `() => new Worker()`.
Phase 3 workers own browser contexts; constructing all of them at boot would launch
Chromium instances we never use.

**Workers are dumb on purpose.** A worker gets an `ExecutionContext` (id, action, dryRun,
logger, AbortSignal) and returns a `WorkerOutcome`. It never touches HTTP, the database,
or notifications. That is what makes them genuinely swappable rather than swappable in
theory.

**One envelope, one error path.** Every response is `{ success, data | error, meta }`,
discriminated on `success`. Every error — validation, provider, unhandled — is shaped by
[`errorHandler.ts`](src/middleware/errorHandler.ts). Stack traces are logged, never sent.

**Correlation via `AsyncLocalStorage`.** `requestId` and `executionId` are attached to
every log line without threading a logger through call signatures. Phase 9 streams live
logs to the dashboard by keying on `executionId` — this is the groundwork.

**Liveness ≠ readiness.** `/health` never touches the database, so a slow Neon query
cannot get a healthy container killed mid-automation. `/health/ready` probes Postgres and
returns 503 when it is unreachable.

### Project layout

```
backend/
├── prisma/
│   ├── schema.prisma              # ExecutionHistory · Setting · User · Notification
│   └── migrations/                # baseline migration, committed
├── src/
│   ├── automation/                # the engine — no HTTP knowledge
│   │   ├── types.ts               # ProviderId · AutomationWorker · contexts
│   │   ├── provider.registry.ts   # the factory
│   │   ├── automation.service.ts  # orchestration & cross-cutting concerns
│   │   └── workers/
│   │       └── naukri.worker.ts   # Phase 1 stub; Phase 3 fills in Playwright
│   ├── config/                    # env (Zod-validated) · logger · prisma
│   ├── controllers/               # thin HTTP adapters
│   ├── core/                      # errors · response envelope · async context
│   ├── middleware/                # context · logging · validate · rate limit · errors
│   ├── routes/
│   ├── utils/
│   ├── validation/                # Zod request schemas
│   ├── app.ts                     # Express assembly (no port binding)
│   └── server.ts                  # lifecycle: listen + graceful shutdown
├── Dockerfile                     # 4-stage build, non-root runtime
└── docker-compose.yml             # Postgres + API for local development
```

---

## Getting started

**Requirements:** Node **22+** (`nvm use`), and either Docker or a reachable Postgres.

```bash
cd backend
cp .env.example .env
npm install
npx prisma generate
npm run dev            # http://localhost:8080
```

### With Docker (no local Postgres needed)

```bash
docker compose up --build
```

Brings up Postgres, waits for it to be genuinely healthy, applies migrations, and starts
the API on `:8080`.

### Applying migrations against your own database

```bash
npm run prisma:migrate     # development: creates + applies
npm run prisma:deploy      # production/CI: applies committed migrations only
```

---

## API

All responses share one envelope:

```jsonc
// success
{ "success": true, "data": { … }, "meta": { "requestId": "…", "timestamp": "…" } }

// error
{ "success": false, "error": { "code": "…", "message": "…", "details": … },
  "meta": { "requestId": "…", "timestamp": "…" } }
```

Send `X-Request-Id` to have your own trace ID adopted end to end; otherwise one is
minted and returned in both the header and `meta.requestId`.

### `POST /api/profile/update`

Runs the `profile.update` action against a provider.

```jsonc
{
  "provider": "naukri", // required — must be a registered provider
  "trigger": "API", // optional — API | CRON | MANUAL (default API)
  "dryRun": false // optional — run the pipeline, mutate nothing
}
```

```bash
curl -X POST http://localhost:8080/api/profile/update \
  -H 'content-type: application/json' \
  -d '{"provider":"naukri"}'
```

```jsonc
{
  "success": true,
  "data": {
    "executionId": "31105557-281b-481d-809c-63813061f139",
    "provider": "naukri",
    "action": "profile.update",
    "trigger": "API",
    "status": "SUCCESS",
    "success": true,
    "message": "Naukri worker executed.",
    "durationMs": 1,
    "startedAt": "2026-08-03T09:22:46.205Z",
    "finishedAt": "2026-08-03T09:22:46.206Z",
    "details": { "stub": true, "dryRun": false }
  },
  "meta": { "requestId": "…", "timestamp": "…" }
}
```

The same endpoint serves `{"provider":"linkedin"}` the moment a LinkedIn worker is
registered. No change to this route, its controller, or its schema.

**Status codes:** `200` request handled (check `data.status` for the automation's own
outcome) · `400` validation / unsupported provider · `429` rate limited · `502`
automation failed · `504` execution timed out · `500` unexpected.

### `GET /api/providers`

Capability discovery, read from the registry — so the dashboard and mobile app never
ship a duplicated hardcoded list.

```jsonc
{ "success": true,
  "data": { "providers": [ { "provider": "naukri", "supportedActions": ["profile.update"] } ] },
  "meta": { … } }
```

### `GET /health` · `GET /health/ready`

Liveness (cheap, no dependencies — point Render's health check here) and readiness
(probes Postgres, `503` when down).

---

## Adding a provider

1. `src/automation/workers/linkedin.worker.ts` implementing `AutomationWorker`.
2. Add `linkedin: () => new LinkedInWorker(),` to the registry.

That is the whole change. Validation, the controller, the service and the API contract
all pick it up automatically.

```ts
export class LinkedInWorker implements AutomationWorker {
  readonly provider: ProviderId = 'linkedin';
  readonly supportedActions: readonly AutomationAction[] = ['profile.update'];

  async execute(context: ExecutionContext): Promise<WorkerOutcome> {
    context.signal.throwIfAborted();
    return { success: true, message: 'LinkedIn worker executed.' };
  }
}
```

Convention: return `success: false` for an expected, describable non-success; **throw**
for genuine breakage. The service classifies both — workers never build HTTP responses.

---

## Configuration

Validated by Zod at boot; an invalid environment exits immediately with a readable report
rather than failing mid-run at 3am. See [.env.example](.env.example).

| Variable                    | Default            | Purpose                                              |
| --------------------------- | ------------------ | ---------------------------------------------------- |
| `NODE_ENV`                  | `development`      | `development` \| `test` \| `production`              |
| `PORT` / `HOST`             | `8080` / `0.0.0.0` | HTTP bind                                            |
| `DATABASE_URL`              | —                  | **Required.** Postgres connection string             |
| `LOG_LEVEL`                 | `info`             | `error` … `debug`                                    |
| `CORS_ORIGINS`              | `*`                | Comma-separated allowlist, or `*`                    |
| `EXECUTION_TIMEOUT_MS`      | `120000`           | Hard ceiling per automation run                      |
| `AUTOMATION_API_KEY`        | —                  | Shared secret for cron callers (consumed in Phase 2) |
| `RATE_LIMIT_WINDOW_SECONDS` | `60`               | API rate-limit window                                |
| `RATE_LIMIT_MAX_REQUESTS`   | `60`               | Requests per window                                  |

Secrets live in the environment only — never in the `Setting` table, never in git.

---

## Scripts

| Command                     | Purpose                          |
| --------------------------- | -------------------------------- |
| `npm run dev`               | Watch mode via tsx               |
| `npm run build`             | Compile to `dist/`               |
| `npm start`                 | Run the compiled server          |
| `npm run typecheck`         | `tsc --noEmit`                   |
| `npm run lint` / `lint:fix` | Type-aware ESLint                |
| `npm run format`            | Prettier                         |
| `npm run prisma:generate`   | Regenerate the Prisma client     |
| `npm run prisma:migrate`    | Create + apply a migration (dev) |
| `npm run prisma:deploy`     | Apply migrations (prod/CI)       |
| `npm run prisma:studio`     | Browse the database              |

---

## Operational notes

- **Graceful shutdown.** SIGTERM stops accepting connections, drains in-flight work,
  closes the Prisma pool, and hard-exits after 15s if draining stalls. Render sends
  SIGTERM on every deploy; from Phase 3 a running automation owns a browser process, so
  this path is what prevents leaked Chromium and stuck `RUNNING` history rows.
- **Rate limiting is per-instance** (in-memory store). Correct for a single Render
  instance; switch to a Redis store before scaling horizontally.
- **Logs go to stdout only.** Containers are ephemeral and the platform owns log
  shipping. Execution _history_ is a database concern, not a logfile concern.
- **`prisma` is a runtime dependency**, not a dev dependency, so `prisma migrate deploy`
  can run as a release step inside the production image.
- **Docker base image changes in Phase 3.** Playwright needs system browser libraries;
  the runtime stage moves to `mcr.microsoft.com/playwright:*`. Hand-installing libs onto
  `node:22-slim` invites version skew between the npm package and the system browser.

## Known limitations (Phase 1, by design)

- The Naukri worker is a stub — no Playwright, no credentials, no selectors.
- Nothing is written to `execution_history` yet. The service has two marked seams for it.
- No authentication. `AUTOMATION_API_KEY` is defined but not yet enforced.
- No automated tests. `app.ts` is already decoupled from port binding so Supertest can
  mount it directly.

## Roadmap

| Phase | Scope                                                                  | Status  |
| ----- | ---------------------------------------------------------------------- | ------- |
| 1     | Engine skeleton, provider factory, validation, logging, errors, Docker | ✅ Done |
| 2     | Render deployment, GitHub Actions cron trigger, API-key auth           | Next    |
| 3     | Playwright: login, profile update, screenshot on failure               |         |
| 4     | Persist execution history                                              |         |
| 5     | Email notifications (Nodemailer)                                       |         |
| 6     | Next.js dashboard                                                      |         |
| 7     | React Native app                                                       |         |
| 8     | Push notifications                                                     |         |
| 9     | Live execution logs over WebSocket                                     |         |
