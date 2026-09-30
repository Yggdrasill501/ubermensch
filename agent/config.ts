// All daemon configuration comes from .env (see .env.example).
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (see .env.example / docs/SETUP.md)`);
  return v;
}
const opt = (name: string) => process.env[name] || undefined;

export const config = {
  anthropicModel: process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",

  slack: {
    botToken: () => req("SLACK_BOT_TOKEN"),
    appToken: () => req("SLACK_APP_TOKEN"), // xapp-..., Socket Mode
    defaultChannel: () => req("SLACK_DEFAULT_CHANNEL"), // channel id where the agent reports work
  },
  github: {
    token: () => req("GITHUB_TOKEN"),
    repo: () => req("GITHUB_REPO"), // "owner/name" of the demo repo the agent works on
  },
  linear: {
    apiKey: () => req("LINEAR_API_KEY"),
    teamKey: () => req("LINEAR_TEAM_KEY"), // e.g. "ENG"
    // Only issues with this label are picked up ("" = every backlog issue).
    label: process.env.LINEAR_LABEL ?? "ubermensch",
  },
  cursor: {
    apiKey: () => req("CURSOR_API_KEY"),
    model: opt("CURSOR_MODEL"), // omit to use Cursor's default model
  },
  /** "cursor" (Cursor Cloud Agents) or "claude" (local Claude Agent SDK worker in a git worktree). */
  workerBackend: (process.env.WORKER_BACKEND ??
    (process.env.CURSOR_API_KEY ? "cursor" : "claude")) as "cursor" | "claude",
  autoMerge: (process.env.AUTO_MERGE ?? "true") !== "false",
  exaApiKey: opt("EXA_API_KEY"),
  firecrawlApiKey: opt("FIRECRAWL_API_KEY"),

  workspacesDir: process.env.WORKSPACES_DIR ?? `${process.env.HOME}/ubermensch-workspaces`,
  maxWorkers: Number(process.env.MAX_WORKERS ?? 3),
  workerMaxTurns: Number(process.env.WORKER_MAX_TURNS ?? 80),
  heartbeatMinutes: Number(process.env.HEARTBEAT_MINUTES ?? 5),
  dispatchIntervalMs: 2000,
};
