# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Tachyon is a mobile-first AI trading platform ("Gamified Trading Bot Arena") where users build customizable AI trading bots that propose trades for user approval. The project is in the planning/pre-implementation phase -- The full MVP spec lives in `.claude/docs/product/technical_product_spec.md`. This project will consist of several sibling directories under a single GitHub organization. 

This repository is the tachyon-works directory. It will serve as the workers service for the tachyon application.

## Tech Stack (Planned)

- **Mobile:** React Native + Unistyles
- **Auth:** Auth0
- **API:** GraphQL (primary) + REST (webhooks)
- **Databases:** PostgreSQL + Weaviate
- **Queue:** Redis + BullMQ
- **Infra:** DigitalOcean, Docker
- **Observability:** Sentry
- **AI:** TBD

## Architecture

```
[Mobile App - React Native]
        |
[GraphQL API Gateway] -- [Postgres]
        |
[Job Queue / Workers - Redis + BullMQ]
        |
[Broker Adapter] <-> [Broker API]
```

Key separation: API handles orchestration + validation. Workers handle scanning, proposals, execution. AI generates explanations only -- never enforces rules or makes execution decisions.

### Core Services

1. **Mobile App** -- FTUE, bot builder, proposal inbox, positions, funding UI (tachyon-mobile repo)
2. **API Gateway** -- GraphQL with Auth0 JWT, rate limiting, emits commands to queue (tachyon-api repo)
3. **Trading Orchestrator** -- Market scanning, proposal generation (deterministic scoring), risk enforcement, order submission, EOD summaries
4. **Broker Integration** -- Adapter pattern normalizing broker APIs, webhook receiver
5. **Funding & Ledger** -- Double-entry ledger, deposits/withdrawals
6. **Notification Service** -- Push notifications, delivery tracking
7. **Reporting Service** -- EOD bot reports, weekly recaps
8. **Admin Console** -- User/bot inspection, compliance flags

### Critical Design Constraints

- **User approval required for every trade** -- no autonomous execution
- **Deterministic Rule Engine** enforces all safety limits (capital allocation, daily max loss/gain, trade frequency, holding periods, position limits) -- these are never delegated to AI
- **Long-only, stocks + ETFs only, one open position per bot** (MVP)
- Language must avoid "passive income" or "AI trades for you" claims

## Agent System

This project uses a multi-agent workflow. Agents are activated via `/become <agent-id>` slash commands.

| ID | Name | Role |
|---|---|---|
| `dev` | Clem | Full Stack Developer -- implementation, APIs, React Native, GraphQL |
| `architect` | Kevin | System Architect -- system design, TDDs, infrastructure |
| `pm` | Brock | Product Manager -- FRDs, PDRD, product strategy, UX |
| `analyst` | Maria | Business Analyst -- market research, competitive analysis |
| `sm` | Rob | Scrum Master -- engineering task creation in Archon |
| `ssm` | Katrina | Social Media Manager -- social content |

Agent definitions live in `.claude/agents/`. Each agent has custom commands prefixed with `*` (e.g., `*cook`, `*taskify`, `*audit`).

## Documentation Workflow

- **Templates** in `.claude/templates/` -- TDD, FRD, PDRD, market research, competitor analysis, project brief
- **Document flow:** PDRD -> FRDs -> TDDs -> Dev tasks
- **Product spec:** `.claude/docs/product/technical_product_spec.md`
- FRDs go in `.claude/docs/frds/`, TDDs go in `.claude/docs/tdds/`

## Hooks

Python-based hooks in `.claude/hooks/` run via `uv`:
- `pre_tool_use.py` -- blocks dangerous operations (`rm -rf`, `.env` access)
- `post_tool_use.py` -- logs all tool outcomes
- `stop.py` -- session tracking and chat archiving

## MCP Integrations

- **Archon** -- project management (tasks, documents, versions)
- **Playwright** -- browser automation
- All project MCP servers enabled via `settings.json`
