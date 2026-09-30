# WS2 — Brain (triage + dispatch) and heartbeat (proactive pickup)

Read `PLAN.md` and `src/lib/db.ts` first. You own **`agent/brain.ts`**, **`agent/heartbeat.ts`**,
**`agent/sources/linear.ts`**, **`agent/sources/github.ts`**. Keep exported signatures as in the stubs.
Import `postMessage`/`addReaction` from `./slack` (WS1) and `runTask`/`runningWorkers` from `./worker` (WS3)
— they're stubs now; test your code with those mocked.

## sources/linear.ts (`@linear/sdk`)
Implement the 4 helpers. Team by `config.linear.teamKey()`. Backlog = state type `backlog` or `unstarted`.
`setIssueState` looks up the team's workflow state by name (case-insensitive). `createIssue` returns
identifier + url.

## sources/github.ts (`@octokit/rest`)
`listOpenIssues` — open issues in `config.github.repo()`, excluding PRs.

## heartbeat.ts
Every `config.heartbeatMinutes` and once ~10s after boot: insert a `backlog_item` event per Linear backlog
issue (`externalId: "linear:" + id`, payload = issue) and per GitHub issue (`"github:" + number`).
Also `logActivity("event", "Heartbeat: checked backlog (n new)")`. Catch errors per source (a missing key
must not crash the daemon).

## brain.ts
`triage(event, playbook)`: Anthropic TS SDK, model `config.anthropicModel` with `output_config.effort: "low"`,
structured output matching `Decision`. **Invoke the `claude-api` skill before writing this** (structured
outputs shape, no forced tool_choice on Opus 5.5, fallbacks). Prompt = playbook (the agent's job description;
if null, the agent is not hired yet → only reply "I haven't been onboarded yet, DM me 'you're hired'")
+ the event + list of open tasks (to avoid duplicates) + rules:
- Proactive: for `backlog_item` events, create a task if it falls within the playbook's responsibilities.
- Chit-chat/questions answerable in one message → `reply`. Real work → `create_task` with a short `ack`.
- Thread replies: check `findOpenQuestionByThread(channel, thread_ts)` **in code before calling the model** —
  if one exists → `answer_question` directly.

`startDispatcher()`: `setInterval(tick, config.dispatchIntervalMs)` with a re-entrancy guard. tick:
1. For each `nextUnhandledEvents()`: decide, apply, `markEventHandled`, `logActivity("decision", ...)`.
   - reply → `postMessage(channel, text, thread_ts ?? ts)`.
   - create_task from Slack → `addReaction(channel, ts, "eyes")`, post `ack` in thread, also
     `createIssue` in Linear (sourceRef = Linear issue id; put identifier/url in description), and
     `createTask({... slackChannel: channel, slackThreadTs: thread_ts ?? ts })`.
   - create_task from backlog → `postMessage(defaultChannel, "Picking up ENG-12: <title>")`, its ts becomes
     `slackThreadTs`; `createTask({ sourceRef: issue id, ... })`.
   - answer_question → `answerQuestion`, `updateTask(task_id, { status: "queued" })`, react ✅.
2. While `runningWorkers() < config.maxWorkers`: `claimNextQueuedTask()` → `void runTask(task)`.
Never let one bad event kill the loop: try/catch per event, mark handled, log `error`.

## Self-test
Unit-ish script with mocked slack/worker: insert fake events (dm, channel message, backlog item, thread
reply to an open question) → run one tick → assert tasks/questions/activity rows. Then real Linear +
GitHub calls against the demo workspace.
