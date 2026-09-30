// WS3 — Worker: one fresh Claude Agent SDK session per task, in its own git worktree.
// See docs/briefs/WS3-worker.md
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { query, type McpServerConfig, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { QuestionRow, TaskRow } from "../src/lib/db";
import { getDb, getPlaybook, getTask, logActivity, recall, remember, updateTask } from "../src/lib/db";
import { config } from "./config";
import { postMessage } from "./slack";
import { runTaskWithCursor } from "./worker-cursor";
import { ASK_HUMAN_TOOL, COWORKER_SERVER, createCoworkerTools, ensureThread } from "./tools";

const pexec = promisify(execFile);
const running = new Set<string>();

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

// ---------------------------------------------------------------- git workspace

async function run(cmd: string, args: string[], cwd?: string, timeoutMs = 10 * 60_000) {
  try {
    const { stdout } = await pexec(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message: string };
    // never leak the token that lives in the clone URL
    const detail = (err.stderr || err.message).replace(/x-access-token:[^@]+@/g, "x-access-token:***@");
    throw new Error(`${cmd} ${args[0]} failed: ${trunc(detail.trim(), 500)}`);
  }
}

// Serializes clone/fetch/worktree add|remove on the shared base repo (git locks don't like parallelism).
let baseLock: Promise<unknown> = Promise.resolve();
function withBaseLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = baseLock.then(fn, fn);
  baseLock = next.catch(() => undefined);
  return next;
}

/** Remote URL of the repo the worker operates on. Overridable for offline tests. */
function remoteUrl(): string {
  if (process.env.UBERMENSCH_REMOTE_URL) return process.env.UBERMENSCH_REMOTE_URL;
  return `https://x-access-token:${config.github.token()}@github.com/${config.github.repo()}.git`;
}

const baseDir = () => path.join(config.workspacesDir, "_base");

async function ensureBase(): Promise<string> {
  const base = baseDir();
  if (!fs.existsSync(path.join(base, ".git"))) {
    fs.mkdirSync(config.workspacesDir, { recursive: true });
    fs.rmSync(base, { recursive: true, force: true });
    await run("git", ["clone", remoteUrl(), base], undefined, 5 * 60_000);
    await run("git", ["config", "user.name", "Übermensch"], base);
    await run("git", ["config", "user.email", "ubermensch@users.noreply.github.com"], base);
  } else {
    await run("git", ["remote", "set-url", "origin", remoteUrl()], base); // token may have rotated
  }
  await run("git", ["fetch", "--prune", "origin"], base, 5 * 60_000);
  return base;
}

async function defaultBranch(base: string): Promise<string> {
  try {
    await run("git", ["rev-parse", "--verify", "--quiet", "origin/main"], base);
    return "origin/main";
  } catch {
    await run("git", ["remote", "set-head", "origin", "--auto"], base).catch(() => undefined);
    return run("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], base);
  }
}

export const branchFor = (task: TaskRow) => `ubermensch/${task.id.slice(0, 8)}`;

/**
 * Makes sure the task has a git worktree on its own branch; reuses an existing one (resume).
 * Exported for the offline self-test.
 */
export async function prepareWorkspace(task: TaskRow): Promise<string> {
  const dir = path.join(config.workspacesDir, task.id);
  if (fs.existsSync(path.join(dir, ".git"))) return dir; // resuming: keep the work in progress

  await withBaseLock(async () => {
    const base = await ensureBase();
    const start = await defaultBranch(base);
    await run("git", ["worktree", "prune"], base);
    fs.rmSync(dir, { recursive: true, force: true });
    await run("git", ["worktree", "add", "-B", branchFor(task), dir, start], base);
  });

  if (fs.existsSync(path.join(dir, "package.json"))) {
    const hasLock = fs.existsSync(path.join(dir, "package-lock.json"));
    try {
      await run("npm", [hasLock ? "ci" : "install", "--no-audit", "--no-fund"], dir);
    } catch (e) {
      // not fatal: the agent can see and fix a broken install itself
      logActivity("error", `npm install in workspace failed: ${trunc(errMsg(e), 300)}`, task.id);
    }
  }
  return dir;
}

/** Exported for the offline self-test. */
export async function removeWorkspace(dir: string): Promise<void> {
  await withBaseLock(async () => {
    await run("git", ["worktree", "remove", "--force", dir], baseDir()).catch(() => {
      fs.rmSync(dir, { recursive: true, force: true });
      return run("git", ["worktree", "prune"], baseDir()).catch(() => undefined);
    });
  });
}

// ---------------------------------------------------------------- prompt

function latestAnsweredQuestion(taskId: string): QuestionRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM questions WHERE task_id = ? AND answer IS NOT NULL
       ORDER BY answered_at DESC, created_at DESC LIMIT 1`,
    )
    .get(taskId) as QuestionRow | undefined;
}

export function buildSystemAppend(task: TaskRow): string {
  const playbook = getPlaybook() ?? "(No playbook yet. Act as a careful senior software engineer.)";
  const memories = recall(task.title, 8);
  const memoryText = memories.length
    ? memories.map((m) => `- [${m.kind}] ${trunc(oneLine(m.content), 400)}`).join("\n")
    : "(nothing relevant yet)";
  const repo = process.env.GITHUB_REPO ?? "(the repo in your working directory)";

  return `
# Who you are
You are Übermensch, an AI coworker. Your manager hired you with this playbook (your job description — follow it, especially any rules about when to ask first):

<playbook>
${playbook}
</playbook>

You are one of several parallel workers of this coworker; you own exactly this task and nothing else. Your working directory is a git worktree of ${repo} on branch \`${branchFor(task)}\`. Only change files inside it.

# Your task
Title: ${task.title}
Source: ${task.source}${task.source_ref ? ` (ref: ${task.source_ref})` : ""}
Description:
${task.description || "(none)"}

# Relevant memory from earlier work
${memoryText}

# How you work
- Work on your own; the humans are in Slack, not at the terminal.
- Use \`mcp__${COWORKER_SERVER}__report_progress\` at real milestones only (at most 3 times), e.g. "found the root cause: …", "PR opened: <url>".
- If you are blocked, unsure about intent, or the playbook says to ask before doing something this task requires: call \`${ASK_HUMAN_TOOL}\` with one clear question, then STOP immediately — end your turn with no further tool calls. You will be resumed with the answer.
- If the task is tracked in Linear (an identifier like ENG-12 in the ref or description), use \`mcp__${COWORKER_SERVER}__linear_update\` to move it to "In Progress" when you start and to "Done" (with a comment linking the PR) when finished.
- When the change is done:
  1. Run the project's tests/lint (see its CLAUDE.md / package.json) and make them pass.
  2. Commit with a clear message, then \`git push -u origin HEAD\` (never force-push, never push to main directly).
  3. Open a PR with \`gh pr create --fill\` (or a short title/body that references the task).
  4. Only if the playbook explicitly allows you to merge AND the tests pass: \`gh pr merge --squash --delete-branch\`. Otherwise leave the PR open for review.
- Some commands are not permitted in this environment; if one is denied, find another way or ask a human.
- Use \`mcp__${COWORKER_SERVER}__remember\` for non-obvious learnings future tasks would benefit from.
- Your final message must be a 2–3 line summary of what you did, including the PR URL.
`.trim();
}

// ---------------------------------------------------------------- permissions

// Headless, locked-down tool surface: anything not listed here (and not a read-only action) is denied.
const ALLOWED_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "Edit(/**)", // file writes only inside the worktree (the session cwd)
  "TodoWrite",
  "Bash(git status*)",
  "Bash(git diff*)",
  "Bash(git log*)",
  "Bash(git show*)",
  "Bash(git add *)",
  "Bash(git commit *)",
  "Bash(git checkout *)",
  "Bash(git switch *)",
  "Bash(git restore *)",
  "Bash(git stash*)",
  "Bash(git fetch*)",
  "Bash(git pull*)",
  "Bash(git rebase origin/*)",
  "Bash(git push*)",
  "Bash(gh pr *)",
  "Bash(gh issue view *)",
  "Bash(gh run *)",
  "Bash(npm *)",
  "Bash(npx *)",
  "Bash(node *)",
  "Bash(ls*)",
  "Bash(mkdir *)",
  "Bash(cat *)",
  `mcp__${COWORKER_SERVER}__*`,
  "mcp__playwright__*",
  "mcp__exa__*",
  "mcp__firecrawl__*",
];

const DISALLOWED_TOOLS = [
  "Bash(git push --force*)",
  "Bash(git push -f*)",
  "Bash(git push * --force*)",
  "Bash(git push * -f*)",
  "Bash(git push origin main*)",
  "Bash(git push origin HEAD:main*)",
  "Bash(git reset --hard origin/main*)",
  "Bash(git config *)",
  "Bash(gh repo *)",
  "Bash(gh api *)",
  "Bash(gh auth *)",
  "Bash(gh secret *)",
  "Bash(npm publish*)",
  "Bash(sudo *)",
];

/** Only what the agent needs; Slack/Linear/other daemon secrets never reach the agent process. */
function workerEnv(): Record<string, string | undefined> {
  const keep = ["PATH", "HOME", "USER", "SHELL", "LANG", "TMPDIR", "TERM", "NODE_ENV", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"];
  const env: Record<string, string | undefined> = {};
  for (const k of keep) if (process.env[k]) env[k] = process.env[k];
  env.GH_TOKEN = process.env.GITHUB_TOKEN;
  env.GH_REPO = process.env.GITHUB_REPO;
  env.GIT_TERMINAL_PROMPT = "0";
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "ubermensch/0.1";
  return env;
}

function mcpServers(task: TaskRow): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {
    [COWORKER_SERVER]: createCoworkerTools(task),
    playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"] },
  };
  if (config.exaApiKey) {
    servers.exa = {
      type: "http",
      url: `https://mcp.exa.ai/mcp?exaApiKey=${encodeURIComponent(config.exaApiKey)}`,
    };
  }
  if (config.firecrawlApiKey) {
    servers.firecrawl = {
      command: "npx",
      args: ["-y", "firecrawl-mcp"],
      env: { FIRECRAWL_API_KEY: config.firecrawlApiKey },
    };
  }
  return servers;
}

// ---------------------------------------------------------------- run

function describeToolUse(name: string, input: unknown): string {
  const short = name.replace(/^mcp__(.+?)__/, "$1.");
  const i = (input ?? {}) as Record<string, unknown>;
  const pick =
    i.command ?? i.file_path ?? i.pattern ?? i.url ?? i.question ?? i.text ?? i.query ?? i.description;
  const detail = typeof pick === "string" ? pick : JSON.stringify(input ?? {});
  return `${short}: ${trunc(oneLine(detail), 160)}`;
}

async function safePost(task: TaskRow, text: string): Promise<void> {
  try {
    const { channel, threadTs } = await ensureThread(task);
    await postMessage(channel, text, threadTs);
  } catch (e) {
    console.warn(`[worker] slack post failed for ${task.id}: ${errMsg(e)}`);
  }
}

/** Finds the PR for the task branch via the GitHub API (fallback when the agent's text has no URL). */
async function findPrForBranch(branch: string): Promise<string | null> {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return null;
  try {
    const owner = repo.split("/")[0];
    const res = await fetch(
      `https://api.github.com/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) return null;
    const prs = (await res.json()) as { html_url: string }[];
    return prs[0]?.html_url ?? null;
  } catch {
    return null;
  }
}

interface StreamOutcome {
  resultText: string;
  allText: string; // assistant text + tool results, for PR URL extraction
  error: string | null;
  sawMessages: boolean;
}

async function streamQuery(task: TaskRow, prompt: string, options: Options): Promise<StreamOutcome> {
  const abort = new AbortController();
  const out: StreamOutcome = { resultText: "", allText: "", error: null, sawMessages: false };
  let asked = false; // ask_human was called; the model must stop, so further tool use is cut off
  let sessionStored = false;

  try {
    for await (const msg of query({ prompt, options: { ...options, abortController: abort } })) {
      out.sawMessages = true;
      if (!sessionStored && "session_id" in msg && msg.session_id) {
        if (msg.session_id !== task.session_id) updateTask(task.id, { session_id: msg.session_id });
        sessionStored = true;
      }
      if (msg.type === "assistant" && msg.parent_tool_use_id === null) {
        for (const block of msg.message.content) {
          if (block.type === "text" && block.text.trim()) {
            out.allText += `\n${block.text}`;
            logActivity("progress", trunc(oneLine(block.text), 300), task.id);
          } else if (block.type === "tool_use") {
            if (asked && block.name !== ASK_HUMAN_TOOL) {
              abort.abort();
              break;
            }
            if (block.name === ASK_HUMAN_TOOL) asked = true;
            logActivity("tool", describeToolUse(block.name, block.input), task.id);
          }
        }
      } else if (msg.type === "user" && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (typeof block === "object" && block.type === "tool_result") {
            const c = block.content;
            out.allText += `\n${typeof c === "string" ? c : JSON.stringify(c ?? "")}`;
          }
        }
      } else if (msg.type === "result") {
        if (msg.subtype === "success" && !msg.is_error) {
          out.resultText = msg.result;
        } else {
          out.error =
            msg.subtype === "success" ? msg.result || "API error" : `${msg.subtype}: ${msg.errors.join("; ")}`;
        }
      }
    }
  } catch (e) {
    if (!abort.signal.aborted) out.error ??= errMsg(e);
  }
  return out;
}

/**
 * Runs (or resumes) a task end to end. Never throws — failures set status "failed" and log.
 *  - workspace: clone GITHUB_REPO once into WORKSPACES_DIR/_base, then `git worktree add` per task
 *  - if task.session_id is set and the task has an answered question: resume the session with the answer
 *  - query({ prompt, options: { cwd, systemPrompt (preset claude_code + playbook + task brief + recalled memory),
 *            mcpServers: coworker tools (./tools) + playwright (+ exa/firecrawl if keys), permissions,
 *            maxTurns, model } })
 *  - stream messages -> logActivity("tool" | "progress", ...), store session_id
 *  - if ask_human set status "waiting_on_human" -> stop; otherwise mark "done", store summary + pr_url,
 *    remember("task_summary", ...), and post the result in the task's Slack thread
 */
export async function runTask(task: TaskRow): Promise<void> {
  if (config.workerBackend === "cursor") return runTaskWithCursor(task, running);
  return runTaskWithClaude(task);
}

/** Claude Agent SDK backend: local session in a git worktree (WORKER_BACKEND=claude). */
export async function runTaskWithClaude(task: TaskRow): Promise<void> {
  if (running.has(task.id)) return; // already being worked on
  running.add(task.id);
  try {
    if (task.status !== "running") updateTask(task.id, { status: "running" });

    // Every task gets a Slack thread (dashboard/heartbeat tasks have none yet); non-fatal without Slack.
    await ensureThread(task, `👀 Picking up: *${task.title}*`).catch((e) =>
      console.warn(`[worker] could not open a Slack thread for ${task.id}: ${errMsg(e)}`),
    );

    const cwd = await prepareWorkspace(task);
    if (task.workspace !== cwd) updateTask(task.id, { workspace: cwd });

    const answered = task.session_id ? latestAnsweredQuestion(task.id) : undefined;
    const resuming = Boolean(task.session_id && answered);
    logActivity(
      "progress",
      resuming ? `Resuming "${task.title}" with the human's answer` : `Started working on "${task.title}"`,
      task.id,
    );

    const options: Options = {
      cwd,
      model: config.anthropicModel,
      systemPrompt: { type: "preset", preset: "claude_code", append: buildSystemAppend(task) },
      permissionMode: "dontAsk", // headless: anything outside the allowlist is denied, never prompted
      allowedTools: ALLOWED_TOOLS,
      disallowedTools: DISALLOWED_TOOLS,
      maxTurns: config.workerMaxTurns,
      settingSources: ["project"], // loads the demo repo's CLAUDE.md
      mcpServers: mcpServers(task),
      env: workerEnv(),
      stderr: (d) => {
        if (process.env.UBERMENSCH_DEBUG) console.error(`[worker ${task.id.slice(0, 8)}] ${d}`);
      },
    };

    let out = resuming
      ? await streamQuery(
          task,
          `Your manager answered your question ("${answered!.question}"):\n\n${answered!.answer}\n\nContinue.`,
          { ...options, resume: task.session_id! },
        )
      : await streamQuery(task, "Do the task described in your system prompt. Start now.", options);

    if (resuming && out.error && !out.sawMessages) {
      // session transcript missing (e.g. different machine): start fresh, carrying the answer along
      logActivity("error", `Could not resume session (${trunc(out.error, 200)}); starting fresh`, task.id);
      out = await streamQuery(
        task,
        `Do the task described in your system prompt. Earlier you asked: "${answered!.question}". ` +
          `Your manager answered: ${answered!.answer}`,
        options,
      );
    }

    if (getTask(task.id)?.status === "waiting_on_human") {
      logActivity("progress", "Paused: waiting for a human answer in Slack", task.id);
      return;
    }
    if (out.error) throw new Error(out.error);

    const summary = trunc(out.resultText.trim() || "Finished (no summary).", 1500);
    const urls = `${out.allText}\n${out.resultText}`.match(PR_URL_RE);
    const prUrl = urls?.[urls.length - 1] ?? (await findPrForBranch(branchFor(task)));

    updateTask(task.id, { status: "done", summary, pr_url: prUrl });
    remember("task_summary", `${task.title}: ${oneLine(summary)}${prUrl ? ` (${prUrl})` : ""}`, task.id);
    await safePost(task, `✅ Done: ${summary}${prUrl && !summary.includes(prUrl) ? `\n${prUrl}` : ""}`);
    logActivity("result", `${task.title}: ${trunc(oneLine(summary), 250)}${prUrl ? ` — ${prUrl}` : ""}`, task.id);

    await removeWorkspace(cwd).catch((e) =>
      console.warn(`[worker] worktree cleanup failed for ${task.id}: ${errMsg(e)}`),
    );
  } catch (e) {
    const msg = errMsg(e);
    console.error(`[worker] task ${task.id} failed: ${msg}`);
    try {
      updateTask(task.id, { status: "failed", summary: trunc(`Failed: ${msg}`, 1500) });
      logActivity("error", `${task.title}: ${trunc(msg, 400)}`, task.id);
    } catch (dbErr) {
      console.error(`[worker] could not record failure: ${errMsg(dbErr)}`);
    }
    await safePost(task, `❌ I couldn't finish this: ${trunc(msg, 500)}`);
  } finally {
    running.delete(task.id);
  }
}

/** Number of workers currently running (the brain uses it to fill slots). */
export function runningWorkers(): number {
  return running.size;
}
