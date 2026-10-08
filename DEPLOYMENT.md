# Aurex MVP — Build, Features & Deployment Guide

> **Aurex gives an AI agent its own computer and a job — then lets it work.**

This document covers what the Aurex MVP does, how it is built, and how to
install and run it on **your own server or PC**, step by step.

---

## Table of contents

1. [What was built](#1-what-was-built)
2. [Features](#2-features)
3. [Architecture](#3-architecture)
4. [How an agent run works](#4-how-an-agent-run-works)
5. [Prerequisites](#5-prerequisites)
6. [Installation (server or PC)](#6-installation-server-or-pc)
7. [Configuration](#7-configuration)
8. [Running with PM2 (long-lived services)](#8-running-with-pm2-long-lived-services)
9. [Using the portal](#9-using-the-portal)
10. [Using the API directly](#10-using-the-api-directly)
11. [Security model](#11-security-model)
12. [Troubleshooting](#12-troubleshooting)
13. [What's next (post-MVP)](#13-whats-next-post-mvp)

---

## 1. What was built

Aurex is an **AI agent execution platform**. A user creates a project, Aurex
spins up an **isolated Linux workspace** (a Docker container) with development
tools preinstalled, an **AI agent (opencode)** is launched inside that workspace
with a task, and the agent does real work — reading the project, writing code,
running commands, testing, fixing errors — while **streaming its activity live**
to the user over SSE.

The MVP targets **AI-powered software development**: an agent that can build
and test a small project autonomously and return a working result.

The MVP is fully functional and was verified end-to-end (see section 4).

---

## 2. Features

### Core workflow
- **Projects** — create/manage named projects, each with its own persistent workspace.
- **Linux workspaces** — per-project Docker container with Node.js 22, Python 3,
  Git, build tools, and the opencode agent engine preinstalled. Workspaces are
  startable/stopable and keep their files between runs (named volume).
- **Agent runs** — give a model a task; the agent works autonomously:
  - reads/analyzes the project
  - creates files and folders
  - writes and edits code
  - runs terminal commands
  - installs dependencies
  - runs the app and tests
  - detects and fixes errors
  - reports a final result
- **Live streaming** — every step is streamed to the browser in real time via
  SSE: text output, tool calls (with input), step transitions, and final result.
- **Run history** — every run and every event is persisted; you can replay any
  past run's full activity.

### Model support (provider gateway)
- **Default: `opencode/big-pickle`** — free cloud model, no API key required.
- Additional free opencode models seeded (`deepseek-v4-flash-free`, `laguna-s-2.1-free`).
- **BYOK** — set `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` in `.env`; the keys are
  injected into the workspace only for runs that need them.
- Architecture is provider-independent (a `ModelConfig` DB table + `/api/models`
  endpoint) so new providers can be added without touching the core.

### Platform plumbing
- Postgres 16 (Dockerized) — application database via Prisma.
- Redis + BullMQ — background job queue for workspace lifecycle and agent runs.
- SSE event streaming over Redis pub/sub.
- Resource limits on every workspace container (CPU, memory, pids) and a hard
  per-run timeout.

---

## 3. Architecture

```
~/aurex  (npm-workspaces monorepo)
├── docker-compose.yml          # postgres:16 (port 5435)
├── docker/workspace/           # AI workspace image (node+git+python+opencode)
├── packages/
│   ├── shared/                 # shared TS types & constants
│   ├── db/                     # Prisma schema + client
│   └── docker/                 # Docker orchestration helpers (dockerode)
└── apps/
    ├── api/                    # Express REST + SSE      (port 4010)
    ├── worker/                 # BullMQ worker            (agent execution)
    └── web/                    # React/Vite portal        (port 5173)
```

```
Browser (React portal, :5173)
    │  REST + SSE (proxied to :4010)
    ▼
aurex-api (Express)
    │  POST /api/runs → enqueue BullMQ job
    │  GET /api/runs/:id/events → SSE stream
    ▼
Redis (host :6379)  ── BullMQ queue + pub/sub
    │
    ▼
aurex-worker (BullMQ consumer)
    │  ensure workspace container exists (dockerode)
    │  docker exec: opencode run --format json --auto --model <model> "<task>"
    ▼
Workspace container (aurex-ws-<id>, isolated, non-root, resource-limited)
    │  NDJSON events
    ▼
Postgres (AgentRun + AgentEvent rows)  ──►  Redis pub/sub  ──►  SSE  ──►  browser
```

### Data model (Prisma)
- **Project** — name, description, status.
- **Workspace** — one per project; container id, image, status, resource limits.
- **AgentRun** — one per task; model, provider, task, status, exit code, error,
  result, timestamps.
- **AgentEvent** — the full activity audit trail (seq, type, data JSON).
- **ModelConfig** — model/provider registry.

---

## 4. How an agent run works

```
User creates project
  → POST /api/runs { projectId, task, model }
  → worker creates/starts the workspace container (if needed)
  → worker runs inside it:  opencode run --format json --auto --model opencode/big-pickle "<task>"
  → the agent reads the project, writes code, runs commands, tests, fixes errors
  → every event (text / tool call / step) is stored in Postgres and streamed to the browser
  → run completes → final status + result summary + exit code
```

**Verified end-to-end test:** a run was given the task *"build a Node.js CLI
that prints the first 10 Fibonacci numbers"*. The agent created `fib.js`,
`package.json`, and `README.md` inside the container, ran `node fib.js`, the
output `0 1 1 2 3 5 8 13 21 34` was correct, and the run exited `0`.

---

## 5. Prerequisites

You need a **Linux machine** (a VPS/server or a PC with Linux — the agent
workloads are Linux containers). It must have:

| Requirement | Version | Notes |
|-------------|---------|-------|
| **Docker** | 24+ (Compose v2) | daemon running; your user must be able to use it |
| **Node.js** | 20+ (24 recommended) | `node -v` |
| **npm** | 9+ | bundled with Node |
| **Git** | any recent | to clone / for workspaces |
| **Redis** | 6.2+ recommended (6.0 works with a warning) | `redis-server`; host Redis is used, no container needed |
| **Internet** | required | pulls base images and reaches the model API |
| **RAM / disk** | 4 GB+ RAM free, ~5 GB disk | workspace image is ~1.9 GB; agents need headroom |

> **Optional:** a running **Ollama** (`http://localhost:11434`) if you want
> local models. The workspace containers can reach it via `host.docker.internal`
> when configured.

### Check your environment

```bash
docker ps                    # docker works (no sudo)
docker compose version       # compose available
node -v && npm -v            # node/npm
redis-cli ping               # → PONG
```

If `docker ps` fails with a permission error, add your user to the `docker`
group: `sudo usermod -aG docker $USER` and re-login.

---

## 6. Installation (server or PC)

### Step 1 — Get the code

```bash
cd ~
git clone <your-aurex-repo-url> aurex
cd aurex
```

If the project is not in a git repo yet, copy the `aurex/` folder to the target
machine with `scp`/`rsync` instead.

### Step 2 — Install Node dependencies

```bash
npm install
```

### Step 3 — Start Postgres (Docker)

```bash
docker compose up -d postgres
docker compose ps        # wait for "healthy"
```

> This maps Postgres to host port **5435** so it never collides with any
> existing Postgres on 5432/5433.

### Step 4 — Prepare the database

```bash
npx prisma db push --schema packages/db/prisma/schema.prisma
npm run db:seed --workspace @aurex/db
```

This creates the tables and seeds the default models
(`big-pickle`, `deepseek-v4-flash-free`, `laguna-s-2.1-free`).

### Step 5 — Build the workspace image

```bash
npm run workspace:build
```

> **This is the slow step** (5–15 min): it installs system packages and
> `opencode-ai@1.18.15` globally inside the image. If your Docker Hub pulls are
> flaky, retry — it resumes cached layers.

Verify the image:

```bash
docker run --rm --entrypoint sh aurex-workspace:latest \
  -c "which opencode node git python3 && opencode --version"
# expect: /usr/local/bin/opencode ... 1.18.15
```

### Step 6 — Configure `.env`

```bash
cp .env.example .env   # or edit the existing .env
```

See [Configuration](#7-configuration) for every variable.

### Step 7 — Run the three services

In three separate terminals (or use PM2 — see section 8):

```bash
npm run dev:api       # terminal 1  →  http://localhost:4010
npm run dev:worker    # terminal 2
npm run dev:web       # terminal 3  →  http://localhost:5173
```

### Step 8 — Verify

```bash
curl http://localhost:4010/api/health        # {"ok":true,...}
curl http://localhost:5173/api/models        # list of models
```

Open **http://localhost:5173**, create a project, and give the agent a task.

---

## 7. Configuration

All config lives in the root `.env`:

| Variable | Default | Purpose |
|----------|---------|---------|
| `DATABASE_URL` | `postgresql://aurex:aurex@localhost:5435/aurex?schema=public` | Postgres connection |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `API_PORT` | `4010` | REST/SSE API port |
| `WORKSPACE_IMAGE` | `aurex-workspace:latest` | workspace image tag |
| `DEFAULT_MODEL` | `opencode/big-pickle` | default model |
| `RUN_TIMEOUT_MS` | `600000` (10 min) | hard timeout per agent run |
| `OPENAI_API_KEY` | *(empty)* | BYOK — injected into workspaces when set |
| `ANTHROPIC_API_KEY` | *(empty)* | BYOK — injected into workspaces when set |

Per-workspace resource limits are set at workspace creation time and stored in
the DB (default: 2 CPUs, 4 GB memory, 512 pids, 10-min timeout). You can change
them in `apps/api/src/routes/workspaces.ts`.

---

## 8. Running with PM2 (long-lived services)

The repo ships `ecosystem.config.cjs`. On servers this is the recommended way
to keep Aurex running across restarts.

```bash
npm install -g pm2                    # if not installed
pm2 start ecosystem.config.cjs
pm2 save                              # persist across reboot
pm2 startup                            # generate systemd autostart command (run the printed command)
```

Useful commands:

```bash
pm2 list                              # status of aurex-api / aurex-worker / aurex-web
pm2 logs aurex-api                    # tail logs
pm2 restart aurex-api aurex-worker aurex-web
pm2 stop aurex-web                    # stop only the frontend
```

**Important:** `pm2 startup` prints a command (e.g. `sudo env PATH=... pm2 startup
systemd -u <user> --hp <home>`) — run that once so Aurex comes back after a
server reboot.

### Exposing the web portal publicly

The portal runs on port 5173 (Vite dev server). For a production deployment you
should serve the built frontend and proxy `/api`:

```bash
cd apps/web && npm run build      # produces apps/web/dist
```

Then serve `dist/` with any static server (nginx, caddy, `python3 -m http.server`)
and reverse-proxy `/api` to `http://localhost:4010`. Example nginx snippet:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location /api {
        proxy_pass http://localhost:4010;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location / {
        root /path/to/aurex/apps/web/dist;
        try_files $uri /index.html;   # SPA routing
    }
}
```

For SSE through nginx, add:

```nginx
proxy_buffering off;
proxy_read_timeout 3600s;
proxy_set_header Connection '';
proxy_http_version 1.1;
```

---

## 9. Using the portal

### Dashboard (`/`)
- Lists all projects with their run counts and workspace status.
- **Create project** — name + optional description.

### Project view (`/projects/:id`)
- **Linux workspace card** — create/start/stop the workspace container; shows
  container id, image, resource limits, and the files produced inside it.
- **Give the agent a job** — pick a model, write a task, click **Start agent run**.
- **Run history** — table of past runs with status/model/result.

### Run view (`/runs/:id`)
- Live stream of agent activity via SSE (text, tool calls, step transitions).
- A **● live** badge while the run is in progress; auto-scrolls.
- On completion: final status, exit code, result, and any error.

---

## 10. Using the API directly

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | health check |
| GET | `/api/projects` | list projects |
| POST | `/api/projects` | create project `{ name, description? }` |
| GET | `/api/projects/:id` | project + workspace + runs |
| DELETE | `/api/projects/:id` | delete project |
| POST | `/api/workspaces/:projectId/ensure` | create/start workspace container |
| POST | `/api/workspaces/:id/start` | start workspace |
| POST | `/api/workspaces/:id/stop` | stop workspace |
| GET | `/api/workspaces/:id` | workspace detail |
| POST | `/api/runs` | queue agent run `{ projectId, task, model? }` |
| GET | `/api/runs/:id` | run + events |
| GET | `/api/runs/:id/events` | **SSE** stream of agent activity |
| GET | `/api/models` | available models |
| GET | `/api/files/:projectId` | files inside the workspace |

Example — create a project and start a run:

```bash
PID=$(curl -s -X POST localhost:4010/api/projects -H 'Content-Type: application/json' \
  -d '{"name":"demo"}' | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

RID=$(curl -s -X POST localhost:4010/api/runs -H 'Content-Type: application/json' \
  -d "{\"projectId\":\"$PID\",\"task\":\"Create a file hello.txt containing 'hi'.\",\"model\":\"opencode/big-pickle\"}" \
  | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")

curl -sN localhost:4010/api/runs/$RID/events     # stream the activity
curl -s  localhost:4010/api/runs/$RID            # final status + result
```

---

## 11. Security model

Aurex never lets an agent run arbitrary commands on your host.

- **Full container isolation** — agents run inside Docker containers; the host
  is unreachable except through the Docker API used by the worker.
- **Non-root execution** — the workspace runs as an unprivileged `agent` user.
- **Resource limits** — CPU, memory, and pids caps per container.
- **Filesystem boundary** — the workspace is a named volume mounted at
  `/workspace`; no host directories are mounted.
- **No TTY/privileged mode** — containers are created without privileged flags.
- **Hard timeout** — `RUN_TIMEOUT_MS` kills runaway runs.
- **Audit trail** — every agent event is persisted (`AgentEvent`); activity is
  replayable and auditable.
- **Secrets** — BYOK API keys are injected only into the workspace container as
  environment variables, never stored in the database.

> The opencode CLI is launched with `--auto` (auto-approve permissions). This is
> safe here precisely because the agent is confined to an isolated, resource-
> limited container. Do not run the agent on the host directly.

---

## 12. Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| `docker: ... failed to resolve reference ... TLS` | Docker Hub flaky. Retry the pull/build; it resumes cached layers. Use cached images (`postgres:16-alpine`). |
| API crashes with `EADDRINUSE :::4010` | Port 4010 is already used by an old instance. `pm2 delete aurex-api` or kill the stale process, then restart. |
| BullMQ warning "minimum Redis version 6.2.0, Current 6.0.16" | Harmless. It still works. Upgrade Redis if you want the warning gone. |
| `ERR_MODULE_NOT_FOUND .../config.js` | Stale process from before an edit. Restart the api/worker processes. |
| Worker never picks up runs | Redis connection — confirm `redis-cli ping` and that `REDIS_URL` points at the right port (host redis = 6379). |
| Workspace container missing after reboot | `docker compose up -d postgres` brings back Postgres; workspace containers are recreated on demand by the worker (data persists in the named volume). |
| Agent run times out | Increase `RUN_TIMEOUT_MS` or the workspace `timeoutMs` resource limit. |
| Web shows connection refused | Vite proxy target defaults to `localhost:4010`; make sure the API is running on the same host. |
| `Cannot find module '@aurex/...'` | Run `npm install` again from the repo root (workspace symlinks). |

---

## 13. What's next (post-MVP)

The MVP proves the core concept. Roadmap ideas from the original spec:

- **Model gateway expansion** — Ollama local models, Gemini, etc.
- **Aurex agent core** — progressively replace the opencode dependency with
  Aurex's own orchestration.
- **AI workforce** — specialist workers (Developer, QA, Data, DevOps) each with
  their own tools, prompts, and permissions.
- **Enterprise** — multi-tenant orgs, RBAC/PBAC, SSO, audit dashboards, quotas,
  self-hosted/Kubernetes deployments.
- **Workspace enhancements** — network policies, per-run secret scoping,
  snapshotting, artifact downloads.
