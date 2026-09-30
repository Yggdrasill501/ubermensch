@AGENTS.md

# Übermensch

Autonomous AI coworker: lives in Slack/Linear/GitHub, picks up work on its own, spawns parallel
Claude Agent SDK workers, asks humans only when stuck. Hackathon MVP — optimize for a working demo.
Read `PLAN.md` for architecture and workstreams; your brief is in `briefs/`.

## Layout
- `agent/` — daemon (Node 22, run via tsx): `slack.ts` gateway, `onboarding.ts` interview, `brain.ts`
  triage + dispatch, `heartbeat.ts` proactive polling, `worker.ts` + `tools.ts` Agent SDK workers,
  `sources/` Linear/GitHub helpers, `computer.ts` computer use (stretch).
- `src/app/` — Next.js 16 dashboard (Tailwind 4 + DaisyUI 5), polls `GET /api/state`.
- `src/lib/db.ts` — SQLite (better-sqlite3) shared by both. **The contract between workstreams.**

## Commands
- `npm run dev` — dashboard (:3000) + daemon · `npm run web` / `npm run agent` — one of them
- `npm run typecheck` · `npm run build` · `npm run lint`

## Rules for parallel sessions
- Only edit the files your brief owns. Keep exported stub signatures unchanged.
- Don't edit `src/lib/db.ts`, `agent/config.ts`, `agent/index.ts` — ask the user instead.
- Don't add npm packages or commit; tell the user what you need.
- Claude model: `config.anthropicModel` (`claude-opus-5-5`). Invoke the `claude-api` skill before writing
  Anthropic SDK code.
- Env comes from `.env` (see `.env.example`). Missing optional keys must not crash the daemon.
