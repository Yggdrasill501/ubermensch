// WS3 — Worker: one fresh Claude Agent SDK session per task, in its own git worktree.
// See briefs/WS3-worker.md
import type { TaskRow } from "../src/lib/db";

/**
 * Runs (or resumes) a task end to end. Never throws — failures set status "failed" and log.
 *  - workspace: clone GITHUB_REPO once into WORKSPACES_DIR/_base, then `git worktree add` per task
 *  - if task.session_id is set and the task has an answered question: resume the session with the answer
 *  - query({ prompt, options: { cwd, systemPrompt (preset claude_code + playbook + task brief + recalled memory),
 *            mcpServers: coworker tools (./tools) + playwright (+ exa/firecrawl if keys), permissionMode: "bypassPermissions",
 *            maxTurns, model } })
 *  - stream messages -> logActivity("tool" | "progress", ...), store session_id
 *  - if ask_human set status "waiting_on_human" -> stop; otherwise mark "done", store summary + pr_url,
 *    remember("task_summary", ...), and post the result in the task's Slack thread
 */
export async function runTask(task: TaskRow): Promise<void> {
  throw new Error("TODO WS3: runTask");
}

/** Number of workers currently running (the brain uses it to fill slots). */
export function runningWorkers(): number {
  return 0; // TODO WS3
}
