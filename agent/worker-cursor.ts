// Worker backend: Cursor Cloud Agents API (v1). Each task = one durable Cursor agent on GITHUB_REPO;
// a human answer = a follow-up run on the same agent. Docs: https://cursor.com/docs/cloud-agent/api/endpoints
import type { TaskRow } from "../src/lib/db";
import {
  createQuestion,
  getDb,
  getPlaybook,
  logActivity,
  recall,
  remember,
  updateTask,
} from "../src/lib/db";
import { config } from "./config";
import { postMessage } from "./slack";
import { octokit } from "./sources/github";
import { commentOnIssue, setIssueState } from "./sources/linear";
import { ensureThread } from "./tools";

const API = "https://api.cursor.com";
const RUN_TIMEOUT_MS = 45 * 60_000;
const POLL_MS = 10_000;
const TERMINAL = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface CursorRun {
  id: string;
  agentId: string;
  status: string;
  result?: string;
  git?: { branches?: { repoUrl: string; branch: string; prUrl?: string }[] };
}

async function cursor<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.cursor.apiKey()}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`Cursor API ${init?.method ?? "GET"} ${path}: ${res.status} ${trunc(await res.text(), 300)}`);
  }
  return (await res.json()) as T;
}

// ---------------------------------------------------------------- prompt

function buildPrompt(task: TaskRow): string {
  const playbook = getPlaybook() ?? "(no playbook yet: act as a careful software engineer)";
  const memories = recall(task.title, 8)
    .map((m) => `- ${oneLine(m.content)}`)
    .join("\n");
  return `You are a worker of "Übermensch", an autonomous AI coworker on this team. You own exactly one task.

# Your playbook (your job description, written with your manager)
${playbook}

# Your task
Title: ${task.title}
Source: ${task.source}${task.source_ref ? ` (${task.source_ref})` : ""}
${task.description}

# What you remember from earlier work
${memories || "- nothing relevant"}

# How to work
- Read CLAUDE.md / README.md in the repo root first and follow their workflow.
- Fix the root cause with a minimal change, run the tests, and keep everything that passed passing.
- A pull request is opened for you automatically when you finish with changes; write a clear final summary.
- If your playbook or the repo says a human must approve something (e.g. payments code), or you are
  genuinely blocked: DO NOT make that change. End your final reply with exactly one line:
  QUESTION: <one clear, self-contained question for your manager>
  You will get the answer as a follow-up message.
- Otherwise end your final reply with one line:
  SUMMARY: <2 sentences: root cause and fix>`;
}

// ---------------------------------------------------------------- run following

/** Streams run events into the activity feed; returns when the stream ends (or fails). */
async function streamRun(task: TaskRow, agentId: string, runId: string, abort: AbortSignal) {
  let buffer = "";
  const seenCalls = new Set<string>();
  const flush = () => {
    const text = oneLine(buffer);
    if (text.length > 20) logActivity("progress", trunc(text, 300), task.id);
    buffer = "";
  };
  try {
    const res = await fetch(`${API}/v1/agents/${agentId}/runs/${runId}/stream`, {
      headers: { Authorization: `Bearer ${config.cursor.apiKey()}`, Accept: "text/event-stream" },
      signal: abort,
    });
    if (!res.ok || !res.body) return;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let pending = "";
    let event = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += value;
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, "");
        pending = pending.slice(nl + 1);
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(line.slice(5));
          } catch {
            continue;
          }
          if (event === "assistant" && typeof data.text === "string") {
            buffer += data.text;
            if (buffer.includes("\n\n") || buffer.length > 400) flush();
          } else if (event === "thinking" && typeof data.text === "string") {
            flush();
            const text = oneLine(data.text);
            if (text.length > 20) logActivity("progress", `💭 ${trunc(text, 300)}`, task.id);
          } else if (event === "tool_call" && typeof data.callId === "string" && !seenCalls.has(data.callId)) {
            seenCalls.add(data.callId);
            flush();
            const args = data.args ? trunc(oneLine(JSON.stringify(data.args)), 120) : "";
            logActivity("tool", `${String(data.name)} ${args}`.trim(), task.id);
          } else if (event === "done" || event === "result") {
            flush();
            return;
          }
        } else if (line === "") event = "";
      }
    }
  } catch {
    // stream is best-effort; polling below is the source of truth
  } finally {
    flush();
  }
}

async function waitForRun(task: TaskRow, agentId: string, runId: string): Promise<CursorRun> {
  const abort = new AbortController();
  void streamRun(task, agentId, runId, abort.signal);
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  try {
    while (Date.now() < deadline) {
      const run = await cursor<CursorRun>(`/v1/agents/${agentId}/runs/${runId}`).catch(() => null);
      if (run && TERMINAL.has(run.status)) return run;
      await sleep(POLL_MS);
    }
    throw new Error(`Cursor run ${runId} timed out after ${RUN_TIMEOUT_MS / 60_000} min`);
  } finally {
    abort.abort();
  }
}

// ---------------------------------------------------------------- GitHub + Linear follow-through

/** Waits for CI on the PR, then squash-merges it. Returns a human-readable outcome. */
export async function mergeWhenGreen(prUrl: string): Promise<string> {
  const m = prUrl.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return "no PR to merge";
  const [, owner, repo, num] = m;
  const gh = octokit();
  const pull_number = Number(num);
  const deadline = Date.now() + 8 * 60_000;
  let sawChecks = false;
  while (Date.now() < deadline) {
    const { data: pr } = await gh.pulls.get({ owner, repo, pull_number });
    if (pr.merged) return "already merged";
    if (pr.draft) {
      // Cursor opens draft PRs; GitHub refuses to merge drafts.
      await gh.graphql(
        `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`,
        { id: pr.node_id },
      );
    }
    const { data: checks } = await gh.checks.listForRef({ owner, repo, ref: pr.head.sha });
    const runs = checks.check_runs;
    if (runs.length > 0) sawChecks = true;
    const failed = runs.find((r) => r.status === "completed" && !["success", "skipped", "neutral"].includes(r.conclusion ?? ""));
    if (failed) return `not merged: CI check "${failed.name}" ${failed.conclusion}`;
    const allDone = runs.length > 0 && runs.every((r) => r.status === "completed");
    const noCiConfigured = !sawChecks && Date.now() > deadline - 6.5 * 60_000; // no checks after ~90s
    if (allDone || noCiConfigured) {
      await gh.pulls.merge({ owner, repo, pull_number, merge_method: "squash" });
      // Clean up after itself: delete the agent's branch (same-repo PRs only).
      if (pr.head.repo?.full_name === `${owner}/${repo}`) {
        await gh.git.deleteRef({ owner, repo, ref: `heads/${pr.head.ref}` }).catch(() => undefined);
      }
      return allDone ? "merged after CI passed" : "merged (no CI checks found)";
    }
    await sleep(15_000);
  }
  return "not merged: CI still running after 8 min";
}

/** Linear issue id for this task, if it came from (or was mirrored to) Linear. */
function linearIssueId(task: TaskRow): string | null {
  const ref = task.source_ref;
  if (!ref || ref.startsWith("http") || ref.startsWith("slack:")) return null;
  return ref;
}

async function safeLinear(task: TaskRow, state: string, comment?: string) {
  const id = linearIssueId(task);
  if (!id) return;
  try {
    await setIssueState(id, state);
    if (comment) await commentOnIssue(id, comment);
  } catch (e) {
    logActivity("error", `Linear update failed: ${trunc(errMsg(e), 200)}`, task.id);
  }
}

async function safePost(task: TaskRow, text: string) {
  try {
    const { channel, threadTs } = await ensureThread(task);
    await postMessage(channel, text, threadTs);
  } catch (e) {
    console.warn(`[cursor-worker] slack post failed for ${task.id}: ${errMsg(e)}`);
  }
}

function latestAnswer(taskId: string) {
  return getDb()
    .prepare(
      `SELECT question, answer FROM questions WHERE task_id = ? AND answer IS NOT NULL
       ORDER BY answered_at DESC, rowid DESC LIMIT 1`,
    )
    .get(taskId) as { question: string; answer: string } | undefined;
}

// ---------------------------------------------------------------- finishing + merge approval

const MERGE_Q = "🔀 Ready to merge";

/** MERGE_APPROVAL=always|never|playbook (default): does a human approve merges? */
function needsMergeApproval(): boolean {
  const mode = process.env.MERGE_APPROVAL ?? "playbook";
  if (mode === "always") return true;
  if (mode === "never") return false;
  const pb = getPlaybook() ?? "";
  return /\b(after|with|needs?|requires?|upon)\s+(an?\s+)?(approv|review)|don'?t merge|do not merge|approval before merg/i.test(pb);
}

function isApproval(text: string): boolean {
  if (/\b(don'?t|do not|not yet|wait|hold)\b/i.test(text)) return false;
  return /\b(approved?|lgtm|ship it|yes|yep|go ahead|merge it|looks good)\b|👍|✅/i.test(text);
}

async function askToMerge(task: TaskRow, summary: string, prUrl: string) {
  updateTask(task.id, { summary, pr_url: prUrl });
  const { channel, threadTs } = await ensureThread(task);
  await postMessage(
    channel,
    `🔀 *PR ready for review:* ${prUrl}\n${summary}\nReply *approve* and I'll merge it once CI is green, or tell me what to change.`,
    threadTs,
  );
  createQuestion({ taskId: task.id, slackChannel: channel, threadTs, question: `${MERGE_Q}: ${prUrl}` });
  updateTask(task.id, { status: "waiting_on_human" });
  logActivity("question", `Waiting for merge approval: ${prUrl}`, task.id);
  await safeLinear(task, "In Review", `PR ready for review: ${prUrl}`);
}

async function finishTask(task: TaskRow, summary: string, prUrl: string | null, merge: boolean) {
  let mergeNote = "";
  if (prUrl && merge) {
    mergeNote = await mergeWhenGreen(prUrl).catch((e) => `not merged: ${trunc(errMsg(e), 200)}`);
  }
  updateTask(task.id, { status: "done", summary, pr_url: prUrl });
  remember("task_summary", `${task.title}: ${oneLine(summary)}${prUrl ? ` (${prUrl})` : ""}`, task.id);
  const merged = mergeNote.startsWith("merged") || mergeNote === "already merged";
  await safeLinear(
    task,
    merged ? "Done" : "In Review",
    `${summary}${prUrl ? `\n\nPR: ${prUrl}${mergeNote ? ` (${mergeNote})` : ""}` : ""}`,
  );
  await safePost(
    task,
    `${merged ? "🚢 Shipped" : "✅ Done"}: ${summary}${prUrl ? `\n${prUrl}${mergeNote ? ` — ${mergeNote}` : ""}` : ""}`,
  );
  logActivity("result", `${task.title}: ${trunc(summary, 250)}${prUrl ? ` — ${prUrl} (${mergeNote || "open"})` : ""}`, task.id);
}

// ---------------------------------------------------------------- entry point

export async function runTaskWithCursor(task: TaskRow, running: Set<string>): Promise<void> {
  if (running.has(task.id)) return;
  running.add(task.id);
  try {
    if (task.status !== "running") updateTask(task.id, { status: "running" });
    await ensureThread(task, `👀 Picking up: *${task.title}*`).catch(() => undefined);

    const answer = task.session_id ? latestAnswer(task.id) : undefined;
    let agentId: string;
    let runId: string;

    const mergeReview = Boolean(answer?.question.startsWith(MERGE_Q));
    if (mergeReview && isApproval(answer!.answer)) {
      logActivity("answer", `Merge approved: ${answer!.answer}`, task.id);
      await finishTask(task, task.summary ?? "Approved and merged.", task.pr_url, true);
      return;
    }

    if (task.session_id && answer) {
      agentId = task.session_id;
      const text = mergeReview
        ? `Review feedback on your pull request:\n\n${answer.answer}\n\nAddress it by pushing to the same ` +
          `branch/PR, run the tests, and end with a SUMMARY: line.`
        : `Your manager answered your question ("${answer.question}"):\n\n${answer.answer}\n\nContinue the task.`;
      const { run } = await cursor<{ run: CursorRun }>(`/v1/agents/${agentId}/runs`, {
        method: "POST",
        body: JSON.stringify({ prompt: { text } }),
      });
      runId = run.id;
      logActivity(
        "progress",
        mergeReview ? "Addressing review feedback on the PR" : "Resumed Cursor agent with the human's answer",
        task.id,
      );
    } else {
      const { agent, run } = await cursor<{ agent: { id: string; url: string }; run: CursorRun }>(
        `/v1/agents`,
        {
          method: "POST",
          body: JSON.stringify({
            name: trunc(task.title, 100),
            prompt: { text: buildPrompt(task) },
            repos: [{ url: `https://github.com/${config.github.repo()}`, startingRef: "main" }],
            autoCreatePR: true,
            skipReviewerRequest: true,
            ...(config.cursor.model ? { model: { id: config.cursor.model } } : {}),
          }),
        },
      );
      agentId = agent.id;
      runId = run.id;
      updateTask(task.id, { session_id: agentId });
      logActivity("progress", `Cursor agent started: ${agent.url}`, task.id);
      await safeLinear(task, "In Progress");
    }

    const run = await waitForRun(task, agentId, runId);
    if (run.status !== "FINISHED") throw new Error(`Cursor run ended with status ${run.status}`);

    const result = run.result?.trim() ?? "";
    const question = result.match(/^QUESTION:\s*(.+)$/m)?.[1]?.trim();
    if (question) {
      const { channel, threadTs } = await ensureThread(task);
      await postMessage(channel, `❓ ${question}`, threadTs);
      createQuestion({ taskId: task.id, slackChannel: channel, threadTs, question });
      updateTask(task.id, { status: "waiting_on_human" });
      logActivity("question", question, task.id);
      return;
    }

    const summary = trunc(result.match(/^SUMMARY:\s*(.+)$/m)?.[1]?.trim() || oneLine(result) || "Finished.", 1500);
    const prUrl = run.git?.branches?.find((b) => b.prUrl)?.prUrl ?? task.pr_url ?? null;
    if (prUrl && needsMergeApproval()) {
      await askToMerge(task, summary, prUrl);
      return;
    }
    await finishTask(task, summary, prUrl, config.autoMerge);
  } catch (e) {
    const msg = errMsg(e);
    console.error(`[cursor-worker] task ${task.id} failed: ${msg}`);
    updateTask(task.id, { status: "failed", summary: trunc(`Failed: ${msg}`, 1500) });
    logActivity("error", `${task.title}: ${trunc(msg, 400)}`, task.id);
    await safePost(task, `❌ I couldn't finish this: ${trunc(msg, 500)}`);
  } finally {
    running.delete(task.id);
  }
}
