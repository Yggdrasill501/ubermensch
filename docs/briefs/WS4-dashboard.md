# WS4 — Dashboard (Next.js 16 + Tailwind 4 + DaisyUI 5)

Read `docs/PLAN.md`, `src/lib/db.ts` and `AGENTS.md` (Next 16 has breaking changes — check
`node_modules/next/dist/docs/` before using an API). You own **`src/app/**`** only. DaisyUI is already
configured in `globals.css` (light/dark themes).

## Data
`GET /api/state` already returns `{ tasks, activity, playbook }`. Poll it every 2s from a client component
(no websockets needed). Extend the route if you need more (e.g. `memory`, `questions`) using `src/lib/db.ts`
read helpers — add read-only helpers in a new `src/lib/queries.ts` rather than editing db.ts.

## Screens (single page is fine, it's for the demo projector)
- **Header**: name "Übermensch", status badge (online / N workers running), role from the playbook's first heading.
- **Workers board**: kanban columns Queued / Running / Waiting on human / Done (DaisyUI cards). Card: title,
  source badge (Slack/Linear/GitHub/heartbeat), elapsed time, PR link, live pulse on running.
- **Activity feed**: newest first, icon per type, task title, relative time. Clicking a task filters the feed.
- **Playbook** drawer/modal rendering the markdown (plain `<pre className="whitespace-pre-wrap">` is fine).
- **"Hire" empty state** when no playbook: "DM @ubermensch 'you're hired' in Slack to start onboarding".
- Optional: a "Create task" form → `POST /api/tasks` → `createTask({ source: "dashboard", ... })`.

Make it look great on a projector: big type, dark theme, clear colors per status.

## Self-test
Seed the DB with a script (tasks in every status + activity) and check the page at localhost:3000.
`npm run build` must pass.
