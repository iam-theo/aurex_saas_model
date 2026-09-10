# Aurex — AI Workforce Platform

Aurex gives an AI agent its own secure Linux computer and a job to do.
Create a project, spin up an isolated Docker workspace, select a model,
give the agent a task, and watch it work in real time — reading code,
writing files, running commands, testing, and fixing errors until it
delivers a result.

## Architecture

```
~/aurex  (npm workspaces monorepo)
├── docker-compose.yml          # postgres:16 (app DB)
├── docker/workspace/           # AI workspace image (node+git+python+opencode)
├── packages/
│   ├── shared/                 # shared types & constants
│   ├── db/                     # Prisma schema + client
│   └── docker/                 # Docker orchestration helpers
└── apps/
    ├── api/                    # Express REST + SSE (port 4010)
    ├── worker/                 # BullMQ worker: containers + agent runs
    └── web/                    # React/Vite portal (port 5173)
```

Flow: Web → `POST /api/runs` → BullMQ job → worker ensures the workspace
container → runs `opencode run --format json --auto` inside with the task →
NDJSON events streamed via Redis pub/sub → SSE → browser.

## Quick start

```bash
npm install
docker compose up -d postgres          # starts postgres on 5435
npx prisma db push --schema packages/db/prisma/schema.prisma
npm run db:seed --workspace @aurex/db  # seed default models
docker build -t aurex-workspace:latest docker/workspace
# start the three processes (each in its own terminal):
npm run dev:api
npm run dev:worker
npm run dev:web
```

Open http://localhost:5173

## Environment

`.env` at the repo root:
- `DATABASE_URL` — postgres connection (default `postgresql://aurex:aurex@localhost:5435/aurex`)
- `REDIS_URL` — redis connection (host redis on 6379)
- `API_PORT` — 4010
- `DEFAULT_MODEL` — `opencode/big-pickle`
- `RUN_TIMEOUT_MS` — hard timeout per agent run (default 10 min)
- `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` — optional BYOK keys injected into workspaces

## API

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/health` | health check |
| GET    | `/api/projects` | list projects |
| POST   | `/api/projects` | create project |
| GET    | `/api/projects/:id` | project + workspace + runs |
| POST   | `/api/workspaces/:projectId/ensure` | create/start workspace container |
| POST   | `/api/workspaces/:id/start` `/stop` | workspace lifecycle |
| POST   | `/api/runs` | create + queue an agent run |
| GET    | `/api/runs/:id` | run + events |
| GET    | `/api/runs/:id/events` | **SSE stream** of agent activity |
| GET    | `/api/models` | available model providers |
| GET    | `/api/files/:projectId` | files inside the workspace |

## Security model

Agents run **inside** isolated Docker containers as a non-root `agent` user
with CPU/memory/pids limits, an idle-only entrypoint, and no host mounts
beyond the workspace volume. Arbitrary command execution never touches the
host. Runs have a hard timeout. All agent activity is persisted as an audit
trail of events.
