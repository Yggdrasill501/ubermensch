# Übermensch — MVP plan (4h hackathon, solo + parallel Claude Codes)

## Pitch
An AI coworker you *hire*, not prompt. You onboard it once (it interviews you in Slack about its role),
then it lives in your Slack / Linear / GitHub 24/7: it notices work, picks it up without being asked,
spins up parallel sub-agents so it never runs out of context, ships, and only pings you when it's stuck.
Role-agnostic: the role is whatever the onboarding interview defines — for the demo we hire an engineer.

## The one thing the demo must prove
**It picks up work nobody assigned, does it, and asks a human only when stuck.**

## Architecture
```
Slack (Socket Mode) ─┐                          ┌─> worker #1: Agent SDK session in git worktree ─┐
Linear  (polled) ────┼─> inbox (events) ─> BRAIN┼─> worker #2                                    ├─> Slack thread, Linear state,
GitHub  (polled) ────┘       ▲         triage + └─> worker #3   (MAX_WORKERS)                     ┘   GitHub PR (auto-merged)
                   heartbeat ┘         dispatch          │  tools: coworker MCP (ask_human, remember, report_progress,
                                          ▲              │         linear_update, use_computer*), Playwright, Exa, Firecrawl, gh
                                   playbook + memory <───┘  summaries/learnings written back
Onboarding interview (Slack DM) ──> playbook                   Dashboard (Next.js + DaisyUI) reads the same SQLite
```

- **One process** (`agent/`) = Slack gateway + heartbeat + brain + workers. **One Next.js app** = dashboard.
  They share `src/lib/db.ts` (SQLite, WAL). `npm run dev` runs both.
- **Context never overflows**: the brain holds no task details; every task gets a fresh Agent SDK session
  seeded with playbook + task brief + recalled memory, and writes a summary back when done.
- **Pause/resume**: `ask_human` posts in the task's Slack thread → task `waiting_on_human` → worker exits.
  A reply in that thread → brain answers the question → task `queued` → worker resumes the SDK session.
- **Proactive**: heartbeat polls Linear backlog + GitHub issues every few minutes → inbox → brain decides.
- **Autonomy**: fully autonomous on the demo repo — opens *and merges* PRs, moves Linear issues to Done.

## Stack
TypeScript, Node 22, Next.js 16 + Tailwind 4 + DaisyUI 5, better-sqlite3, `@anthropic-ai/claude-agent-sdk`
(workers), `@anthropic-ai/sdk` (brain triage + onboarding interview + computer use), `@slack/bolt`,
`@linear/sdk`, `@octokit/rest`. Model: `claude-opus-5-5`. Local first, then Render (one web service
with a persistent disk; Socket Mode means no inbound webhooks needed).

Credits used: Render (deploy), Exa + Firecrawl (worker research tools, MCP), Wispr Flow (dictating the
onboarding answers live on stage), Cursor/Claude Code (building). Productboard: vision slide only.

## Workstreams — one Claude Code session each, strict file ownership
| WS | Owner files | Brief |
|---|---|---|
| WS0 | you: accounts/keys; a Claude Code session builds the demo repo | `SETUP.md`, `briefs/WS0-demo-repo.md` |
| WS1 | `agent/slack.ts`, `agent/onboarding.ts` | `briefs/WS1-slack-onboarding.md` |
| WS2 | `agent/brain.ts`, `agent/heartbeat.ts`, `agent/sources/*` | `briefs/WS2-brain-heartbeat.md` |
| WS3 | `agent/worker.ts`, `agent/tools.ts` | `briefs/WS3-worker.md` |
| WS4 | `src/app/**` | `briefs/WS4-dashboard.md` |
| WS5 | `agent/computer.ts` (stretch, only after integration works) | `briefs/WS5-computer-use.md` |

Shared contract (don't change without telling everyone): `src/lib/db.ts`, `agent/config.ts`, `agent/index.ts`,
and the exported function signatures in each stub.

Launch each session in this same checkout with:
`claude "Read CLAUDE.md, PLAN.md and briefs/WSn-*.md, then implement it."`
Sessions don't commit; you commit at checkpoints. Only WS0 installs npm packages — ask before adding one.

## Timeline (4h)
| Time | You | Parallel sessions |
|---|---|---|
| 0:00–0:40 | SETUP.md: Anthropic key, Slack app (manifest), GitHub PAT, Linear key, `.env` | WS0 demo repo, WS1, WS2, WS3, WS4 all start (they code against stubs) |
| 0:40–2:00 | Review diffs, answer questions, test each piece as keys land | WS1–WS4 build + self-test |
| 2:00–2:45 | **Integration**: `npm run dev`, run demo script end to end, fix seams | sessions fix bugs you hand them |
| 2:45–3:15 | Seed demo data (planted bugs, Linear backlog), deploy to Render if stable | WS5 computer use *only if* green |
| 3:15–3:45 | Rehearse demo 2×, record a backup video | — |
| 3:45–4:00 | Buffer / pitch slides | — |

## Demo script (≈4 min)
1. **Hire it** — DM the bot "you're hired". It interviews you (dictate answers with Wispr Flow):
   role = backend engineer on the demo repo, owns bugs, merges when tests pass, asks in #ubermensch before
   touching payments. It writes its playbook → shown on dashboard.
2. **Reactive** — teammate posts in #ubermensch: "checkout crashes on empty cart". Agent 👀s, replies with a
   plan, creates a Linear issue, worker fixes it, opens + merges a PR, replies with the link, Linear → Done.
3. **Asks for help** — a second request touches payments → it asks in the thread → you answer → it resumes.
4. **Proactive** — nobody says anything; heartbeat fires, it posts "Picking up ENG-12 from the backlog"
   and ships it.
5. **Dashboard** — three workers in parallel, live activity feed, playbook, memory.

## Vision slide (not built)
Recording-based onboarding: record yourself doing a job in a hard UI (skill-factory Chrome extension /
screen recording) → the agent turns it into a skill it replays with computer use. Any role (design, ops,
sales) = different playbook + tools. Hermes-style self-improving memory. Real webhooks + cloud sandboxes
(Daytona/E2B) per worker. Productboard as an input source for PM agents.

## Traps
- Self-reply loops → ignore own bot user id everywhere; dedupe by external id.
- Double pickup → `source_ref` is UNIQUE; `claimNextQueuedTask` is transactional.
- Runaway cost → `MAX_WORKERS`, `WORKER_MAX_TURNS`.
- Secrets → dedicated demo repo/workspace; fine-grained PAT scoped to the demo repo only.
- Live flakiness → seeded bugs you've seen it fix twice; backup video.
