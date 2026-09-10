# AUREX
## Enterprise Business Proposal

### The AI-Native Application Execution Platform

---

*Prepared for: Global Investor Summit 2026*
*Classification: Confidential*
*Version: 1.0*

---

## Executive Summary

**Aurex** is an AI-native application execution platform that provides isolated, production-grade workspaces where autonomous AI agents build, debug, research, and deploy software — streamed live to users in real time.

Unlike thin AI wrappers that generate code snippets, Aurex gives each user a **full Docker-isolated development environment** where an AI agent operates with real tools: file systems, package managers, databases, build pipelines, and deployment targets. The agent doesn't just suggest code — it writes, tests, debugs, and ships working applications.

**The core insight:** The gap between "AI generated code" and "AI delivered software" is enormous. Aurex bridges that gap.

### Key Metrics at a Glance

| Metric | Value |
|--------|-------|
| AI Models Supported | 22+ (15 free-tier + 7 built-in + custom) |
| Auto-Selection Categories | 7 (Coding, Reasoning, Multimodal, RAG, Safety, Vision, Lightweight) |
| Prompt System Files | 25 modular prompts across 3 layers |
| API Endpoints | 40+ RESTful + SSE real-time |
| Infrastructure Services | PostgreSQL, Redis, Docker, nginx, PM2 |
| Security Layers | OAuth 2.0, Docker isolation, path traversal protection, MIME validation |
| Deployment | One-command production deploy with auto-rollback |

---

## 1. The Problem

### The AI Code Generation Paradox

The AI industry has solved code generation. It has not solved software delivery.

**Current state of the market:**

1. **Chat-based AI tools** (ChatGPT, Claude, Gemini) generate code snippets that users must manually copy, paste, configure, and deploy. The success rate for "copy-paste-to-production" is near zero for non-trivial applications.

2. **AI coding assistants** (Copilot, Cursor, Windsurf) augment developer workflows but still require a human developer to orchestrate, debug, and ship. They accelerate experts; they don't empower non-experts.

3. **No-code AI builders** (Bolt, v0, Lovable) generate frontend components but lack backend infrastructure, database management, deployment pipelines, and production-grade security. They produce prototypes, not products.

**The unaddressed market:** The 99% of professionals, entrepreneurs, and teams who need custom software but cannot write code, cannot hire developers fast enough, and cannot tolerate prototype-quality outputs.

### Why Existing Solutions Fall Short

| Capability | Chat AI | Coding Assistants | No-Code AI | **Aurex** |
|------------|---------|-------------------|------------|-----------|
| Generates code | Yes | Yes | Yes | Yes |
| Runs in isolated environment | No | Partial | Yes (sandboxed) | **Yes (full Docker)** |
| Has file system access | No | Yes | Limited | **Yes (persistent volumes)** |
| Can install dependencies | No | Yes | No | **Yes** |
| Can run databases | No | Yes | No | **Yes** |
| Can deploy to production | No | No | Partial | **Yes (built-in publish)** |
| Real-time streaming | No | Partial | No | **Yes (SSE)** |
| Multi-model routing | No | No | No | **Yes (7 categories)** |
| Enterprise security | No | No | Partial | **Yes (OAuth, isolation, audit)** |
| Interactive debugging | No | Partial | No | **Yes (Q&A + live chat)** |

---

## 2. The Solution

### Aurex Platform Architecture

Aurex is a **three-tier execution platform** designed for reliability, security, and scale:

```
┌─────────────────────────────────────────────────────┐
│                    FRONTEND (React/Vite)             │
│  Dashboard · Project IDE · File Manager · Live SSE   │
├─────────────────────────────────────────────────────┤
│                    API LAYER (Express)                │
│  40+ Endpoints · SSE Streaming · OAuth 2.0           │
├─────────────────────────────────────────────────────┤
│                WORKER LAYER (BullMQ)                 │
│  Queue Management · Docker Lifecycle · Agent Control │
├─────────────────────────────────────────────────────┤
│              EXECUTION LAYER (Docker)                │
│  Isolated Containers · Persistent Volumes · opencode │
├─────────────────────────────────────────────────────┤
│               DATA LAYER                             │
│  PostgreSQL · Redis · Artifact Storage               │
└─────────────────────────────────────────────────────┘
```

### How It Works

1. **User describes what they want** — "Build a SaaS dashboard with user auth, Stripe billing, and a PostgreSQL database."

2. **Aurex creates an isolated workspace** — A Docker container spins up with a full development environment: Node.js, Python, Git, build tools, and the `opencode` AI agent.

3. **AI agent architect questions first** — Before writing code, the agent asks clarifying questions about scope, tech stack, data model, and security requirements. This is not a chatbot — it's a senior engineer.

4. **Agent builds autonomously** — The agent writes code, creates files, installs dependencies, runs database migrations, sets up authentication, and tests the application — all within the isolated container.

5. **User watches in real time** — Every file edit, tool call, and decision is streamed live via Server-Sent Events. The user sees exactly what the agent is doing.

6. **Interactive refinement** — The user can ask questions, request changes, or redirect the agent mid-build. The agent maintains context across the entire session.

7. **One-click publish** — The completed application is deployed to a production URL with a single click. SSL, CDN, and reverse proxy are handled automatically.

### The Intelligence Layer

Aurex doesn't just use one AI model — it **intelligently routes tasks to the best model for the job**:

| Task Type | Auto-Selected Model | Why |
|-----------|-------------------|-----|
| Code generation | Poolside Laguna S 2.1 (256K context) | Specialized coding model |
| Complex reasoning | Nemotron 3 Ultra (550B params, 1M context) | Largest reasoning model available |
| Image understanding | Nemotron Nano VL (vision + video) | Multimodal capabilities |
| Quick extraction | Liquid LFM 2.5 (2.6B params) | Fast, lightweight |
| Content safety | Nemotron 3.5 Content Safety | Purpose-built safety model |

The **Auto (Intelligent)** mode analyzes the user's task description using regex-based category scoring across 100+ keywords, selects the optimal model, and composes a task-specific system prompt — all transparently.

### The Prompt Engineering System

Aurex's prompt system is **modular, auto-detecting, and composable**:

```
prompts/
├── core/           (4 files) — System identity, behavior, quality, output standards
├── capabilities/   (15 files) — Frontend, Backend, Database, API, Security, etc.
└── workflows/      (6 files) — Build, Modify, Debug, Research, Image Gen, Analyze
```

When a user says "Build a React app with user auth":
1. **Core prompts** establish agent identity and standards
2. **Capability prompts** are auto-detected: `frontend`, `backend`, `database`, `security`
3. **Workflow prompt** is selected: `build-application`
4. All layers are composed into a single, task-optimized system prompt

This means the agent knows exactly how to behave for each type of task — without the user configuring anything.

---

## 3. Market Opportunity

### Total Addressable Market (TAM)

| Segment | 2025 Market Size | 2028 Projected | CAGR |
|---------|-----------------|----------------|------|
| AI Code Generation | $4.2B | $12.8B | 44.6% |
| Low-Code/No-Code Platforms | $13.2B | $32.1B | 34.5% |
| AI Developer Tools | $2.8B | $8.9B | 46.2% |
| **Combined TAM** | **$20.2B** | **$53.8B** | **39.8%** |

### Serviceable Addressable Market (SAM)

Aurex targets the intersection of AI code generation and no-code platforms — the **AI-assisted software delivery** segment:

- **SAM:** $8.5B by 2028
- **Target:** Non-technical professionals, startups, and enterprise innovation teams
- **Differentiation:** Full execution environment (not just code generation)

### Serviceable Obtainable Market (SOM)

Conservative Year 1-3 targets based on comparable platform growth:

| Year | Users | Revenue Model | ARR |
|------|-------|---------------|-----|
| Year 1 | 10,000 | Freemium + Pro tiers | $1.2M |
| Year 2 | 50,000 | + Enterprise licensing | $8.5M |
| Year 3 | 200,000 | + Marketplace + API | $32M |

---

## 4. Business Model

### Revenue Streams

#### 1. SaaS Subscription (Primary)

| Tier | Price | Includes |
|------|-------|----------|
| **Free** | $0/mo | 5 projects/mo, 50 agent runs, shared models |
| **Pro** | $29/mo | Unlimited projects, 500 runs/mo, all models, priority execution |
| **Team** | $79/seat/mo | Everything in Pro + shared workspaces, team management, audit logs |
| **Enterprise** | Custom | SSO/SAML, dedicated infrastructure, SLA, custom model deployment |

#### 2. Usage-Based Compute (Secondary)

- Agent execution time billed per-second after free tier
- GPU-accelerated workspaces for ML/AI tasks
- Persistent workspace storage beyond included limits

#### 3. Marketplace (Tertiary)

- Agent prompt templates (community-created)
- Workflow templates (industry-specific)
- Integration connectors (databases, APIs, services)
- Revenue share: 70% creator / 30% platform

#### 4. Enterprise Licensing

- On-premise deployment licenses
- Custom model integration contracts
- Professional services (migration, training, support)

### Unit Economics

| Metric | Value |
|--------|-------|
| Average Revenue Per User (ARPU) | $42/mo |
| Customer Acquisition Cost (CAC) | $85 |
| Lifetime Value (LTV) | $1,512 |
| LTV:CAC Ratio | 17.8x |
| Gross Margin | 78% |
| Payback Period | 2.0 months |

---

## 5. Competitive Landscape

### Positioning Matrix

```
                    HIGH EXECUTION CAPABILITY
                           │
                           │
         Aurex ◆           │           ◆ Enterprise
         (AI-Native        │             AI Platforms
          Full Stack)      │             (Legacy)
                           │
    ───────────────────────┼───────────────────────
                           │
         No-Code AI ◆     │           ◆ DevOps
         (Bolt, v0,        │             Platforms
          Lovable)         │             (Vercel, Render)
                           │
                    LOW EXECUTION CAPABILITY
    ───────────────────────┼───────────────────────
    CONSUMER/SMALL         │           ENTERPRISE/
    TEAM FOCUS             │           LARGE TEAM FOCUS
```

### Competitive Advantages

1. **Full Execution Environment** — Not a sandbox or preview. A real Docker container with real tools. The agent can install npm packages, run Python scripts, set up databases, and deploy to production.

2. **Multi-Model Intelligence** — Auto-routing across 22+ models means the right AI handles each task. No vendor lock-in. No single-model limitations.

3. **Real-Time Transparency** — Live SSE streaming of every agent action. Users see exactly what's happening. No black boxes.

4. **Modular Prompt Architecture** — 25 composable prompt files that auto-configure based on task type. This is not a monolithic system prompt — it's an engineered prompt pipeline.

5. **Production-Grade Security** — Docker isolation, OAuth 2.0, path traversal protection, MIME validation, resource limits. Enterprise-ready from day one.

6. **One-Click Deployment** — Built-in publishing with SSL, CDN, and reverse proxy. The agent builds it; the user publishes it. Zero DevOps required.

---

## 6. Technical Moat

### What Makes Aurex Defensible

#### Layer 1: Execution Infrastructure
The Docker-isolated workspace architecture is not trivial to replicate. Each user gets:
- A dedicated container with 2 CPU cores, 4 GB RAM, 512 PIDs
- Persistent named volumes for file storage
- Pre-installed toolchain (Node.js 22, Python 3, Git, ripgrep, Tesseract OCR)
- Resource limits enforced at the container level
- Automatic cleanup and lifecycle management

Building and maintaining this infrastructure requires deep DevOps expertise and ongoing operational investment.

#### Layer 2: Intelligence Routing
The multi-model auto-selection engine is a compounding advantage:
- 100+ keyword signals for task categorization
- 7 model categories with performance benchmarking
- Task-specific prompt composition from 25 modular files
- Vision model fallback for image-containing tasks
- Continuous improvement as new models become available

This routing intelligence improves with usage data — a flywheel effect.

#### Layer 3: Prompt Engineering System
The modular prompt architecture is a proprietary knowledge base:
- 15 capability prompts encoding domain expertise (frontend, backend, security, etc.)
- 6 workflow prompts encoding process expertise (build, debug, research, etc.)
- 4 core prompts encoding behavioral standards
- Auto-detection algorithms that match tasks to expertise
- Composition engine that assembles optimal prompts

This system represents months of prompt engineering research and iteration.

#### Layer 4: User Experience
The real-time streaming interface creates a trust relationship that competitors lack:
- Live visualization of agent thinking and action
- Interactive Q&A during execution
- File-level change tracking
- Artifact generation and preview
- One-click publish workflow

Users don't just use Aurex — they trust it. Trust is the hardest competitive advantage to replicate.

---

## 7. Go-to-Market Strategy

### Phase 1: Developer-First Launch (Months 1-6)

**Target:** Technical founders, indie hackers, and developer communities

- Open-source the core platform to build community
- Launch on Product Hunt, Hacker News, and Dev.to
- Create "Build with Aurex" tutorial series
- Partner with AI/ML communities for early adopters
- Target: 5,000 users, 500 active projects

### Phase 2: Professional Expansion (Months 7-12)

**Target:** Non-technical professionals, startup teams, and small businesses

- Launch Pro tier with priority execution
- Create industry-specific templates (e-commerce, SaaS, portfolio)
- Partner with accelerators and incubators
- Launch referral program with usage credits
- Target: 25,000 users, 5,000 active projects

### Phase 3: Enterprise Penetration (Months 13-24)

**Target:** Enterprise innovation teams, digital agencies, and system integrators

- Launch Enterprise tier with SSO/SAML
- Create enterprise deployment packages (on-premise, VPC)
- Build integration connectors (Salesforce, HubSpot, Stripe, etc.)
- Launch marketplace for prompts, workflows, and templates
- Target: 100,000 users, 20,000 active projects

---

## 8. Financial Projections

### Revenue Model (3-Year)

| Metric | Year 1 | Year 2 | Year 3 |
|--------|--------|--------|--------|
| Total Users | 10,000 | 50,000 | 200,000 |
| Paying Users | 800 | 5,000 | 25,000 |
| ARPU (monthly) | $35 | $42 | $48 |
| **SaaS Revenue** | **$336K** | **$2.52M** | **$14.4M** |
| Usage-Based Revenue | $85K | $1.2M | $6.8M |
| Marketplace Revenue | $0 | $320K | $4.2M |
| Enterprise Licensing | $0 | $1.8M | $8.5M |
| **Total Revenue** | **$421K** | **$5.84M** | **$33.9M** |
| | | | |
| Infrastructure Costs | $180K | $1.4M | $6.8M |
| Team (Engineering) | $480K | $1.8M | $4.2M |
| Team (Sales/Marketing) | $120K | $800K | $2.4M |
| **Total Costs** | **$780K** | **$4.0M** | **$13.4M** |
| | | | |
| **Net Income** | **($359K)** | **$1.84M** | **$20.5M** |
| **Gross Margin** | 57% | 76% | 80% |

### Funding Requirements

| Round | Amount | Use of Funds | Timeline |
|-------|--------|-------------|----------|
| **Seed** | $2.5M | Core team (5), infrastructure, launch | Months 1-12 |
| **Series A** | $12M | Scale team (25), enterprise features, go-to-market | Months 13-24 |
| **Series B** | $40M | Global expansion, marketplace, enterprise sales | Months 25-36 |

### Seed Round Allocation

```
Engineering (55%)          ████████████████████  $1.375M
  - 3 Senior Engineers
  - 1 DevOps/SRE
  - 1 AI/ML Engineer

Infrastructure (20%)       ███████               $500K
  - Cloud compute (AWS/GCP)
  - Database hosting
  - CDN and edge

Go-to-Market (15%)         ██████                $375K
  - Developer relations
  - Content marketing
  - Community building

Operations (10%)           ████                  $250K
  - Legal and compliance
  - Office and tools
  - Contingency
```

---

## 9. Team & Hiring Plan

### Current Team

| Role | Focus |
|------|-------|
| Founder/CEO | Product vision, architecture, investor relations |
| Lead Engineer | Full-stack development, infrastructure |

### Year 1 Hires (Seed Round)

| Role | Count | Priority |
|------|-------|----------|
| Senior Full-Stack Engineer | 2 | High |
| DevOps/SRE Engineer | 1 | High |
| AI/ML Engineer | 1 | High |
| Developer Advocate | 1 | Medium |
| **Total** | **5** | |

### Year 2 Hires (Series A)

| Role | Count | Priority |
|------|-------|----------|
| Engineering Team | 10 | High |
| Enterprise Sales | 3 | High |
| Customer Success | 2 | Medium |
| Marketing | 2 | Medium |
| **Total** | **17** | |

---

## 10. Risk Analysis

### Technical Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| AI model API changes/deprecation | High | Multi-model architecture; no single vendor dependency |
| Docker security vulnerabilities | High | Regular image updates; minimal attack surface; resource limits |
| Scaling infrastructure costs | Medium | Usage-based pricing; tiered resource limits; spot instances |
| Agent reliability (hallucination, errors) | Medium | Interactive Q&A; real-time monitoring; rollback capability |

### Market Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Big tech launches competing product | High | Open-source community moat; execution speed; niche focus |
| Slow enterprise adoption | Medium | Start with SMB; prove value; build case studies |
| Regulatory changes (AI, data privacy) | Medium | Privacy-by-design architecture; GDPR compliance; data residency options |

### Operational Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Key person dependency | High | Document everything; cross-train; hire senior engineers |
| Customer support scaling | Medium | Self-service documentation; community forums; AI-assisted support |
| Platform abuse | Medium | Resource limits; usage monitoring; content moderation |

---

## 11. Milestones & Roadmap

### Q1 2026 (Current)
- [x] Core platform architecture
- [x] Docker workspace isolation
- [x] Multi-model routing (22+ models)
- [x] Real-time SSE streaming
- [x] Modular prompt system (25 files)
- [x] Image generation (Pollinations.ai)
- [x] One-click publish
- [x] Google OAuth 2.0
- [x] File manager with edit mode
- [x] Context-aware auto-completion

### Q2 2026
- [ ] Public beta launch
- [ ] 10,000 user milestone
- [ ] Stripe billing integration
- [ ] Team collaboration features
- [ ] Template marketplace (beta)

### Q3 2026
- [ ] Enterprise tier launch
- [ ] On-premise deployment option
- [ ] 25,000 user milestone
- [ ] 50+ workflow templates
- [ ] API access for developers

### Q4 2026
- [ ] Series A fundraise
- [ ] 50,000 user milestone
- [ ] Marketplace launch
- [ ] Enterprise sales team
- [ ] International expansion

---

## 12. The Aurex Vision

### Where We're Going

**Year 1:** The best AI-powered development environment for individual builders.

**Year 2:** The standard platform for AI-assisted software delivery in startups and small teams.

**Year 3:** The enterprise-grade AI execution platform that replaces legacy low-code tools and accelerates digital transformation.

**The 10-year vision:** Every professional has an AI agent that builds, maintains, and deploys their software. Aurex is the execution layer that makes this possible — securely, reliably, and at scale.

### Why Now

1. **AI models are good enough** — Frontier models can write production-quality code. The bottleneck is execution infrastructure, not intelligence.

2. **Docker is mature** — Container orchestration is battle-tested. We can offer enterprise-grade isolation without enterprise-grade complexity.

3. **The no-code market is exploding** — $13.2B in 2025, growing to $32.1B by 2028. The demand is proven.

4. **Developer tools are consolidating** — The market is moving from "many point solutions" to "integrated platforms." Aurex is the platform.

5. **Enterprise AI adoption is accelerating** — 72% of enterprises will deploy AI code generation by 2027 (Gartner). They need execution infrastructure, not just code suggestions.

---

## 13. Investment Terms

### Seed Round

| Term | Detail |
|------|--------|
| **Raise** | $2.5M |
| **Instrument** | Priced equity round (preferred stock) |
| **Valuation** | $12.5M pre-money |
| **Use of Funds** | Engineering (55%), Infrastructure (20%), GTM (15%), Ops (10%) |
| **Milestones** | 10K users, $421K ARR, public beta |
| **Timeline** | 12 months runway to Series A readiness |

### What We're Looking For

- **Strategic investors** with enterprise software portfolios
- **AI-native VCs** who understand the execution layer opportunity
- **Angels** with developer tools or infrastructure experience
- **Advisors** with enterprise sales or AI/ML expertise

---

## 14. Appendix

### A. Technology Stack Summary

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | 22 LTS |
| Language | TypeScript | 5.x |
| Frontend | React + Vite | 19.x / 6.x |
| UI Framework | Material 3 (custom) | — |
| API Framework | Express | 4.x |
| ORM | Prisma | 6.x |
| Database | PostgreSQL | 16 |
| Cache/Queue | Redis + BullMQ | 6.x / 5.x |
| Container Runtime | Docker | 24+ |
| Process Manager | PM2 | 5.x |
| Reverse Proxy | nginx | 1.24+ |
| AI Agent | opencode-ai | 1.18.15 |

### B. API Endpoint Summary

| Category | Endpoints | Protocol |
|----------|-----------|----------|
| Authentication | 4 | REST + OAuth 2.0 |
| Projects | 7 | REST |
| Workspaces | 10 | REST + Docker |
| Agent Runs | 6 | REST + SSE |
| Models | 2 | REST |
| Files | 4 | REST |
| Attachments | 3 | REST + Multipart |
| Artifacts | 4 | REST |
| Prompts | 3 | REST |
| Preview | 1 | Reverse Proxy |
| **Total** | **44** | |

### C. Security Features

| Feature | Implementation |
|---------|---------------|
| Authentication | Google OAuth 2.0 with PKCE |
| Session Management | Signed cookies with expiration |
| Workspace Isolation | Docker containers with resource limits |
| File Access Control | Per-project ownership verification |
| Path Traversal Protection | Normalized path rejection |
| Upload Validation | MIME type whitelist + size limits |
| Internal API Auth | Shared secret header for worker-to-API |
| Subdomain Validation | Reserved name blocking + slug sanitization |

---

*This document is confidential and intended solely for the use of the individual or entity to whom it is addressed. The information contained herein is proprietary to Aurex and may not be reproduced or disclosed without prior written consent.*

---

**Contact:**
Aurex Platform
https://<your-domain>

*Building the future of AI-native software delivery.*
