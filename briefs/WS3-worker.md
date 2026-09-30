# WS3 — Worker agents (Claude Agent SDK) + the coworker's tools

Read `PLAN.md` and `src/lib/db.ts` first. You own **`agent/worker.ts`** and **`agent/tools.ts`**. Keep the
exported signatures. Import `postMessage` from `./slack` (WS1) and Linear helpers from `./sources/linear`
(WS2) — stubs for now; mock them in your self-test.

Docs: Agent SDK TypeScript — https://code.claude.com/docs/en/agent-sdk (typescript reference, custom tools,
MCP, sessions). Types: `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (`query`, `Options`,
`tool`, `createSdkMcpServer`, `SDKMessage`).

## Workspace
`config.workspacesDir/_base` = clone of `https://x-access-token:${GITHUB_TOKEN}@github.com/${GITHUB_REPO}.git`
(clone once, `git fetch` each time). Per task: `git worktree add -B ubermensch/<short-id> <dir>/<task-id> origin/main`,
`npm ci` if package.json exists. Store path in `task.workspace`.

## runTask(task)
- Track running count for `runningWorkers()`.
- System prompt: `{ type: "preset", preset: "claude_code", append }` where append = playbook +
  "You are one of several parallel workers of this coworker; you own exactly this task" + task title/description/
  source + `recall(task.title)` results + rules: work autonomously; use `report_progress` at milestones
  (≤3 times); if blocked or the playbook says to ask → `ask_human` then stop; when done: run tests, commit,
  push, `gh pr create`, and if the playbook allows merging and CI/tests pass → `gh pr merge --squash`;
  update Linear via `linear_update`; `remember` non-obvious learnings; final message = 2–3 line summary incl. PR URL.
- Options: `cwd` = workspace, `model: config.anthropicModel`, `permissionMode: "bypassPermissions"`,
  `maxTurns: config.workerMaxTurns`, `settingSources: ["project"]` (so the demo repo's CLAUDE.md loads),
  env incl. `GH_TOKEN`, `mcpServers`:
  - `coworker`: `createCoworkerTools(task)`
  - `playwright`: `{ command: "npx", args: ["@playwright/mcp@latest", "--headless"] }` (browser use)
  - `exa` if `config.exaApiKey`: `{ type: "http", url: "https://mcp.exa.ai/mcp?exaApiKey=..." }`
  - `firecrawl` if `config.firecrawlApiKey`: `{ command: "npx", args: ["-y", "firecrawl-mcp"], env: { FIRECRAWL_API_KEY } }`
- Resume: if `task.session_id` is set and there's an answered question for the task, call `query` with
  `resume: task.session_id` and prompt "Your manager answered: <answer>. Continue."
- Stream: store `session_id` on the first message; for assistant tool_use blocks
  `logActivity("tool", "<tool name>: <short input>", task.id)`; for assistant text `logActivity("progress", ...)`
  (truncate to ~300 chars).
- After the stream: re-read the task; if `waiting_on_human` → return. Else extract PR URL (regex over the
  result text), `updateTask({ status: "done", summary, pr_url })`, `remember("task_summary", ...)`,
  `postMessage(task.slack_channel, "✅ Done: <summary>", task.slack_thread_ts)`, `logActivity("result")`,
  `git worktree remove`. On error: status `failed`, post ❌ in the thread, log `error`.

## tools.ts — `createSdkMcpServer({ name: "coworker", version: "1.0.0", tools: [...] })`
`ask_human(question)`, `report_progress(text)`, `remember(fact)`, `recall(query)`,
`linear_update(issue_id, state?, comment?)`, and `use_computer(goal)` → calls `useComputer` from
`./computer` (stub; return its error text if it throws). `ask_human`: post in the task thread (if the task
has no thread, post in `SLACK_DEFAULT_CHANNEL` and save the ts as its thread), `createQuestion`,
`updateTask({ status: "waiting_on_human" })`, `logActivity("question")`, and tell the model to stop now.

## Self-test
With only `ANTHROPIC_API_KEY` + `GITHUB_*` set and slack/linear mocked: create a task "Fix DEMO BUG 1:
checkout with empty cart returns 500" and call `runTask` → PR opened on the demo repo, task `done`.
Then a task for DEMO BUG 4 with a playbook saying "ask before touching payments" → task `waiting_on_human`;
answer the question in DB, set queued, run again → resumes the same session.
