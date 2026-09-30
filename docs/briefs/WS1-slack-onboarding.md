# WS1 — Slack gateway + onboarding interview

Read `docs/PLAN.md` and `src/lib/db.ts` first. You own **`agent/slack.ts`** and **`agent/onboarding.ts`** only.
Keep the exported signatures exactly as in the stubs (other workstreams import them).

## agent/slack.ts
- `@slack/bolt` `App` with `socketMode: true`, `token: config.slack.botToken()`, `appToken: config.slack.appToken()`.
- On start: `auth.test` → set `botUserId`.
- Listen to `message` and `app_mention` events. Drop: messages from `botUserId`, bot_message subtypes,
  edits/deletes (`message_changed`, `message_deleted`), and duplicates (an @mention also arrives as a message —
  dedupe by `${channel}:${ts}`; `insertEvent` returns null on duplicates).
- Routing:
  - DM (`channel_type === "im"`): if `isOnboarding(channel)` or text matches /hired|onboard|hire/i and no
    playbook yet (or explicitly asked to re-onboard) → `handleOnboardingMessage`. Else event `slack.dm`.
  - @mention → `slack.mention`; message with `thread_ts` → `slack.thread_reply`;
    other message in `SLACK_DEFAULT_CHANNEL` → `slack.channel_message`.
  - payload `{ channel, ts, thread_ts, user, text }` (strip the `<@BOTID>` mention from text).
  - `logActivity("event", "<short text>")` for each inserted event.
- `postMessage` → `chat.postMessage` (mrkdwn), returns `{ ts }`, `logActivity("message", text, null)`.
- `addReaction` → `reactions.add`, swallow `already_reacted` and all errors.

## agent/onboarding.ts — the agent interviews its new manager
Use the Anthropic TS SDK (`@anthropic-ai/sdk`), model `config.anthropicModel`. **Invoke the `claude-api`
skill before writing this code** (current API shapes: adaptive thinking, no prefill, structured outputs).
- Keep interview state in memory per DM channel (Map) and persist the transcript to
  `remember("onboarding", transcript, channel)` when done.
- System prompt: you are a new hire on your first day; interview your manager to learn your role. Ask ONE
  question at a time, max ~6 questions, covering: role & name, what you own / what "done" means, which repos /
  Linear team / channels, how autonomous to be (merge? deploy?), when to ask for help and whom, working
  style/tone. Be warm and brief. Accept long dictated (Wispr Flow) answers.
- When enough info: generate the playbook markdown (sections: Identity, Responsibilities, Where work
  comes from, How I work, Autonomy & guardrails, When I ask for help, Team) → `setPlaybook(md)` →
  post a short summary + "I'm starting now. I'll check the backlog every few minutes." in the DM.
- Use structured output (or a clear marker) to know when the model decided the interview is complete.

## Self-test (before integration)
With `.env` set: `npx tsx --env-file=.env -e 'import("./agent/slack").then(m=>m.startSlack())'`, DM the
bot "you're hired", finish the interview, check `sqlite3 data/ubermensch.db "select content from memory where kind='playbook'"`.
Post in #ubermensch and verify rows land in `events`. Don't implement brain/worker logic.
