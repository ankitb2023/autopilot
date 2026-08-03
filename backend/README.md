# AutoPilot — Backend

A personal automation platform. One API that runs automations on demand or on a
schedule, records what happened, and (later) emails you about it.

Naukri profile update is the first automation. It is **not** the architecture — Naukri
is one worker plugged into an engine that treats LinkedIn, GitHub and Indeed as equals.

## Architecture

```
POST /api/profile/update
  → Controller           thin adapter; parses input, names the action
  → executeAutomation()  execution id · lock · time budget · timing · logging · errors
  → Execution Lock       TTL lease row; 409 if this provider is already running
  → Provider Registry    ProviderId → lazy worker factory
  → Worker               NaukriWorker | LinkedInWorker | …   (Playwright lives here)
```

### The decisions that matter

**Provider registry, not a `switch`.** [`provider.registry.ts`](src/automation/provider.registry.ts)
maps provider IDs to lazy worker factories. The supported set is _data_, and the Zod
schema derives its enum from it — so validation and the factory cannot drift apart.
Adding LinkedIn is one new file plus one line in the registry.

**Domain vocabulary vs. reality.** `PROVIDER_IDS` lists every provider AutoPilot knows
about; the registry holds only the implemented ones. Unimplemented → 400 naming what
_is_ available.

**Lazy worker construction.** Workers are built per run via `() => new Worker()`. Phase 3
workers own browser contexts; building all of them at boot would launch browsers we
never use.

**Workers are dumb on purpose.** A worker gets an `ExecutionContext` (id, action, dryRun,
logger, AbortSignal) and returns a `WorkerOutcome`. It never touches HTTP or the
database. Return `success: false` for an expected failure; **throw** for real breakage.

**Single-flight per provider.** A cron tick arriving while the previous run is still
going would start a second automation — from Phase 3, two browsers logging into the same
account, a plausible way to get flagged. [`execution.lock.ts`](src/automation/execution.lock.ts)
gates every run on a TTL lease row taken with one atomic upsert. Details, including why
this is not a Postgres advisory lock, are in that file's header comment.

**Correlation without machinery.** The service builds a child logger stamped with
`executionId` + provider and passes it down through the context. Every line of a run is
attributable; no async-context plumbing.

## Getting started

Needs Node 22 (`nvm use`) and a Postgres URL (Neon's free tier is fine).

```bash
cd backend
cp .env.example .env      # then set DATABASE_URL
npm install
npx prisma generate
npm run prisma:migrate    # creates the tables
npm run dev               # http://localhost:8080
```

## API

Plain JSON, no envelope. Errors are always `{ code, message, details? }`.

### `POST /api/profile/update`

```jsonc
{
  "provider": "naukri", // required — must be a registered provider
  "trigger": "API", // optional — API | CRON | MANUAL
  "dryRun": false // optional — run the pipeline, mutate nothing
}
```

```bash
curl -X POST http://localhost:8080/api/profile/update \
  -H 'content-type: application/json' -d '{"provider":"naukri"}'
```

```jsonc
{
  "executionId": "bc41f1d3-d60a-4f89-8211-470b740e3817",
  "provider": "naukri",
  "action": "profile.update",
  "trigger": "CRON",
  "status": "SUCCESS",
  "message": "Naukri worker executed.",
  "durationMs": 2002,
  "startedAt": "2026-08-03T11:20:44.537Z",
  "finishedAt": "2026-08-03T11:20:46.541Z",
  "details": { "stub": true, "dryRun": false }
}
```

The same endpoint serves `{"provider":"linkedin"}` once that worker is registered — no
change to the route, controller or schema.

**Status codes:** `200` handled (check `status` for the automation's own outcome) ·
`400` validation / unknown provider · `409` a run for this provider is already going ·
`502` automation failed · `503` couldn't verify exclusivity, refused · `504` timed out ·
`500` unexpected.

A **409 is normal** for an overlapping cron tick, not an error — there is nothing to
retry, the work is already being done. It carries a `Retry-After` header.

```jsonc
{
  "code": "EXECUTION_IN_PROGRESS",
  "message": "An automation for \"naukri\" is already running.",
  "details": { "lockKey": "naukri", "heldByExecutionId": "bc41f1d3-…" }
}
```

### `GET /api/providers`

```jsonc
{ "providers": [{ "provider": "naukri", "supportedActions": ["profile.update"] }] }
```

### `GET /health`

`{ "status": "ok", "uptimeSeconds": 42 }` — touches nothing, so a slow database can't get
the container restarted mid-automation. Point Render's health check here.

## Adding a provider

1. `src/automation/workers/linkedin.worker.ts` implementing `AutomationWorker`.
2. Add `linkedin: () => new LinkedInWorker(),` to the registry.

That's the whole change. If adding a provider ever requires editing the controller,
route or schema, the architecture has been violated — fix that instead.

```ts
export class LinkedInWorker implements AutomationWorker {
  readonly provider: ProviderId = 'linkedin';
  readonly supportedActions: readonly AutomationAction[] = ['profile.update'];

  async execute({ logger, signal }: ExecutionContext): Promise<WorkerOutcome> {
    signal.throwIfAborted();
    return { success: true, message: 'LinkedIn worker executed.' };
  }
}
```

## Layout

```
src/
├── server.ts                     # express app, routes, listen, graceful shutdown
├── automation/
│   ├── types.ts                  # the domain contract
│   ├── provider.registry.ts      # the factory
│   ├── execution.lock.ts         # single-flight gate
│   ├── automation.service.ts     # orchestration + cross-cutting concerns
│   └── workers/naukri.worker.ts
├── config/                       # env (Zod, fail-fast) · logger · prisma
├── controllers/automation.controller.ts
├── core/errors.ts
├── middleware/errorHandler.ts
├── utils/asyncHandler.ts
└── validation/automation.schema.ts
```

## Configuration

Validated by Zod at boot — an invalid environment exits immediately rather than failing
mid-run. See [.env.example](.env.example).

| Variable               | Default       | Purpose                                    |
| ---------------------- | ------------- | ------------------------------------------ |
| `DATABASE_URL`         | —             | **Required.** Postgres connection string   |
| `NODE_ENV`             | `development` | `development` \| `production`              |
| `PORT`                 | `8080`        | HTTP port                                  |
| `LOG_LEVEL`            | `info`        | `error` … `debug`                          |
| `EXECUTION_TIMEOUT_MS` | `120000`      | Ceiling per run; also drives the lock TTL  |
| `AUTOMATION_API_KEY`   | —             | Cron shared secret (defined, not yet used) |

Secrets live in the environment only, never in the database, never in git.

## Scripts

`dev` · `build` · `start` · `typecheck` · `lint` · `format` · `prisma:generate` ·
`prisma:migrate` · `prisma:deploy` · `prisma:studio`

## Operational notes

- **Graceful shutdown.** SIGTERM stops accepting, drains, closes the Prisma pool, and
  force-exits after 15s. Render sends SIGTERM on every deploy; from Phase 3 a run owns a
  browser process, so this prevents leaked Chromium.
- **A stuck lock self-heals** in `EXECUTION_TIMEOUT_MS + 30s` (~2.5 min). No admin
  force-release endpoint on purpose — the TTL makes one unnecessary, and an endpoint that
  can break mutual exclusion is a foot-gun. Inspect: `SELECT * FROM automation_locks;`
- **`prisma` is a runtime dependency**, not a dev one, so `prisma migrate deploy` can run
  as a Render pre-deploy command.
- **Phase 3 needs a Playwright-capable environment.** Render's standard Node runtime lacks
  the system browser libraries; plan on Render's Docker option or a Playwright base image
  at that point.

## Known limitations (deliberate)

- The Naukri worker is a stub — no Playwright, credentials or selectors.
- Nothing is written to `execution_history` yet; the service has marked seams for it.
- No authentication. `AUTOMATION_API_KEY` exists in config but nothing enforces it.
- No test suite yet.
- The execution lock has no heartbeat, and needs none while the service enforces
  `EXECUTION_TIMEOUT_MS` — a lease always outlives the run it guards. If Phase 3 ever
  needs longer runs, add lease renewal at the same time.

## Roadmap

| Phase | Scope                                                        | Status  |
| ----- | ------------------------------------------------------------ | ------- |
| 1     | Engine, provider registry, execution lock, validation, logs  | ✅ Done |
| 2     | Render deployment, GitHub Actions cron, API-key auth         | Next    |
| 3     | Playwright: Naukri login, profile update, failure screenshot |         |
| 4     | Persist execution history                                    |         |
| 5     | Email notifications                                          |         |
| 6     | Dashboard                                                    |         |
| 7+    | Mobile app · push notifications · live logs                  |         |
