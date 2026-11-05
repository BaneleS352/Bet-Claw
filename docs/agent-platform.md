# Agent Platform Architecture

## Repository Analysis

The repo already had a solid local-agent foundation:

- `apps/api` exposes chat, settings, approvals, file, memory, audit, and capability endpoints.
- `apps/web` provides the local admin UI.
- `packages/db` owns SQLite migrations and repositories.
- `packages/capabilities` handles grants, approvals, leases, and audit events for sensitive actions.
- `packages/memory` ingests local files and retrieves local context.
- `packages/llm`, `packages/config`, and `packages/shared` provide model access, policy, config, schemas, and redaction.

The missing platform layer was orchestration: reusable routines, durable schedules, async jobs, heartbeat processing, and a dynamic skill registry.

## Target Architecture

`@openclaw/agent-os` is the orchestration layer:

- `AgentOS` composes all runtime services.
- `SkillRegistry` registers executable skills with metadata, config, and permissions.
- `RoutineRegistry` stores routine definitions as reusable, composable steps.
- `Scheduler` persists one-time, interval, and cron-style routine schedules.
- `JobQueue` persists async work, statuses, retries, results, errors, and logs.
- `HeartbeatLoop` periodically runs due schedules, processes available jobs, stores state, and records health events.

SQLite remains the local-first source of truth. The API wires Agent OS into startup/shutdown and exposes practical routes for operators and future UI surfaces.

## Core API Routes

- `GET /api/agent-os/status`
- `POST /api/heartbeat/pulse`
- `GET /api/skills`
- `POST /api/skills/:id/jobs`
- `GET /api/routines`
- `POST /api/routines`
- `POST /api/routines/:id/run`
- `POST /api/routines/:id/schedules`
- `GET /api/schedules`
- `POST /api/schedules/:id/cancel`
- `GET /api/jobs`
- `POST /api/jobs/process`
- `GET /api/jobs/:id/logs`
- `POST /api/jobs/:id/cancel`

## Defining A Routine

```json
{
  "id": "routine.morning-review",
  "name": "Morning review",
  "description": "Plan the day and triage messages.",
  "steps": [
    {
      "id": "plan",
      "type": "skill",
      "skillId": "planning.daily",
      "input": {
        "priorities": ["Review active jobs", "Pick one focus block"]
      }
    },
    {
      "id": "triage",
      "type": "skill",
      "skillId": "email.triage"
    }
  ]
}
```

Register it:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:3001/api/routines `
  -ContentType "application/json" `
  -Body (Get-Content .\routine.json -Raw)
```

## Running A Routine As A Job

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:3001/api/routines/routine.morning-review/run `
  -ContentType "application/json" `
  -Body '{"input":{"priorities":["Ship Agent OS docs"]},"maxAttempts":2}'
```

Process queued jobs manually:

```powershell
Invoke-RestMethod -Method Post `
  -Uri http://127.0.0.1:3001/api/jobs/process `
  -ContentType "application/json" `
  -Body '{"limit":5}'
```

## Scheduling A Routine

One-time:

```json
{
  "name": "Today planning",
  "schedule": {
    "type": "once",
    "runAt": "2026-05-19T09:00:00.000Z"
  }
}
```

Interval:

```json
{
  "name": "Inbox sweep",
  "schedule": {
    "type": "interval",
    "everySeconds": 1800
  }
}
```

Cron-style:

```json
{
  "name": "Quarter-hour research check",
  "schedule": {
    "type": "cron",
    "expression": "*/15 * * * *"
  }
}
```

The cron parser intentionally supports a small local-first subset: five fields with `*`, `*/n`, comma lists, and numeric values.

## Heartbeat

The API starts the heartbeat automatically when `agentOs.enabled` is `true`.

```json
{
  "agentOs": {
    "enabled": true,
    "heartbeatIntervalMs": 30000,
    "jobsPerHeartbeat": 5,
    "jobRetryDelayMs": 60000
  }
}
```

The heartbeat stores its latest state under `heartbeat.last`, records heartbeat events, enqueues due scheduled tasks, and processes available jobs. Shutdown is wired through the Fastify `onClose` hook.

## Creating A Skill In Code

```ts
agentOS.skills.register({
  id: "notes.summarize",
  name: "Summarize notes",
  version: "0.1.0",
  permissions: [{ resource: "workspace_notes", access: "read" }],
  handler(input, context) {
    context.log("info", "notes.summarize.started");
    return {
      summary: String(input).slice(0, 200)
    };
  }
});
```

Skills are dynamic at runtime: handlers live in code, while metadata is persisted in SQLite for listing and observability.

## Follow-Up Improvements

- Add a web UI tab for routines, schedules, jobs, and heartbeat events.
- Add plugin package loading from local folders with signed manifests.
- Add richer cron semantics or a cron dependency if the platform needs full cron compatibility.
- Add concurrency limits and named worker pools.
- Add routine input/output schemas.
- Connect specific skills to approved capabilities for file, memory, email, browser, and shell work.
