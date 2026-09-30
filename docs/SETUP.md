# Setup (≈40 min) — do this while the Claude Code sessions build

`cp .env.example .env`, then fill it in as you go. Use Node 22 (`nvm use`).

## 1. Anthropic
Get an API key at console.anthropic.com → `ANTHROPIC_API_KEY`.

## 2. Slack (≈10 min)
1. Create a workspace you admin (or use a test one), and a channel `#ubermensch`.
2. api.slack.com/apps → **Create New App → From a manifest** → paste:
```yaml
display_information:
  name: Übermensch
  description: Your autonomous AI coworker
features:
  bot_user:
    display_name: ubermensch
    always_online: true
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - channels:read
      - groups:history
      - im:history
      - im:read
      - im:write
      - chat:write
      - reactions:write
      - users:read
settings:
  event_subscriptions:
    bot_events:
      - app_mention
      - message.channels
      - message.groups
      - message.im
  interactivity:
    is_enabled: false
  socket_mode_enabled: true
```
3. **Basic Information → App-Level Tokens** → generate one with scope `connections:write` → `SLACK_APP_TOKEN` (xapp-…).
4. **Install to Workspace** → copy the Bot User OAuth Token → `SLACK_BOT_TOKEN` (xoxb-…).
5. In Slack: `/invite @ubermensch` in `#ubermensch`. Right click the channel → View details → copy the
   channel ID (C…) → `SLACK_DEFAULT_CHANNEL`.

## 3. GitHub (≈5 min)
1. Create a new repo `ubermensch-demo` (the WS0 session fills it; it must be a *separate* repo).
2. github.com/settings/personal-access-tokens → fine-grained token, **only that repo**, permissions:
   Contents RW, Pull requests RW, Issues RW, Metadata R → `GITHUB_TOKEN`. `GITHUB_REPO=you/ubermensch-demo`.
3. Make sure `gh` works with it: the worker sets `GH_TOKEN` for its sessions.

## 4. Linear (≈5 min)
1. Create a workspace + team (e.g. key `ENG`) → `LINEAR_TEAM_KEY`.
2. Settings → Security & access → Personal API keys → `LINEAR_API_KEY`.
3. After WS0 is done, create 2–3 backlog issues matching the demo repo's planted bugs (see its `DEMO.md`).

## 5. Cursor (workers, ≈5 min)
1. cursor.com/dashboard → **Integrations**: connect GitHub and give the Cursor app access to `ubermensch-demo`.
2. cursor.com/dashboard → **API Keys** → create one → `CURSOR_API_KEY`. With it set, workers run as
   Cursor Cloud Agents (`WORKER_BACKEND=cursor`); without it they fall back to the local Claude Agent SDK.
3. Cursor opens the PRs; our daemon squash-merges them once CI is green (`AUTO_MERGE=true`), using
   `GITHUB_TOKEN`, so the token needs **Pull requests RW + Contents RW + Checks R** on the demo repo.

No Anthropic key? Leave `ANTHROPIC_API_KEY` empty: onboarding becomes a scripted 6-question interview
and triage uses simple rules. Add a key later and both switch to Claude automatically.

## 6. Optional
- Exa → `EXA_API_KEY`, Firecrawl → `FIRECRAWL_API_KEY` (workers get them as MCP tools when set).
- Docker Desktop running, for WS5 computer use.

## Run
```bash
npm install
npm run dev        # dashboard on http://localhost:3000 + agent daemon
```
Then DM the bot "you're hired".

## Deploy to Render (after it works locally)
One **Web Service**: build `npm install && npm run build`, start `npm start`, Node 22, add a
**Persistent Disk** mounted at `/var/data` and set `DB_PATH=/var/data/ubermensch.db`,
`WORKSPACES_DIR=/var/data/workspaces`, plus all `.env` values. Install `gh` in the build command
(or have workers push with plain git + token URL). Socket Mode = no public webhook URL needed.
