// WS2 — Brain: triages inbox events and keeps worker slots full. See docs/briefs/WS2-brain-heartbeat.md
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import {
  answerQuestion,
  claimNextQueuedTask,
  createTask,
  findOpenQuestionByThread,
  getDb,
  getPlaybook,
  getTask,
  listTasks,
  logActivity,
  markEventHandled,
  nextUnhandledEvents,
  updateTask,
  type EventRow,
  type TaskRow,
} from "../src/lib/db";
import { config } from "./config";
import { addReaction, postMessage } from "./slack";
import { runTask, runningWorkers } from "./worker";
import { createIssue } from "./sources/linear";

export type Decision =
  | { action: "ignore"; reason: string }
  | { action: "reply"; text: string } // quick answer in-thread, no task needed
  | { action: "create_task"; title: string; description: string; ack: string }
  | { action: "answer_question"; questionId: string }; // human replied to an ask_human thread

// ---------- event payload shapes ----------

interface SlackPayload {
  channel: string;
  ts: string;
  thread_ts?: string | null;
  user?: string;
  text?: string;
}

interface BacklogPayload {
  // Linear: LinearIssueLite, GitHub: GithubIssueLite
  id?: string;
  identifier?: string;
  number?: number;
  title: string;
  description?: string;
  body?: string;
  url: string;
  state?: string;
}

function parsePayload<T>(event: EventRow): T {
  return JSON.parse(event.payload) as T;
}

const NOT_ONBOARDED =
  "I haven't been onboarded yet — DM me \"you're hired\" and I'll interview you about my role.";

/** Human-readable reference for a backlog item: "ENG-12" or "#12". */
function backlogRef(event: EventRow, p: BacklogPayload): string {
  if (event.source === "linear") return p.identifier ?? p.id ?? "issue";
  return p.number != null ? `#${p.number}` : "issue";
}

/** Task source_ref for a backlog item (Linear issue id / GitHub issue url) — dedupes pickups. */
function backlogSourceRef(event: EventRow, p: BacklogPayload): string {
  if (event.source === "linear") return p.id ?? event.external_id;
  return p.url || event.external_id;
}

// ---------- triage (Claude) ----------

const TriageSchema = z.object({
  action: z.enum(["ignore", "reply", "create_task"]),
  reason: z.string().describe("One sentence: why this action."),
  reply_text: z.string().describe('Slack message to post when action is "reply", else "".'),
  title: z.string().describe('Short imperative task title when action is "create_task", else "".'),
  description: z
    .string()
    .describe(
      'Task brief for the worker when action is "create_task": what to do, context, acceptance criteria. Else "".',
    ),
  ack: z
    .string()
    .describe(
      'Short Slack acknowledgement (1-2 sentences, a quick plan) when action is "create_task", else "".',
    ),
});

let anthropic: Anthropic | null = null;
function client(): Anthropic {
  anthropic ??= new Anthropic();
  return anthropic;
}

function systemPrompt(playbook: string): string {
  return `You are the triage brain of an autonomous AI coworker that lives in Slack, Linear and GitHub.
Your job description (the playbook, written during onboarding):

<playbook>
${playbook}
</playbook>

For each inbox event decide exactly one action:
- "create_task": real work that falls within your responsibilities (code changes, bug fixes, investigations,
  anything needing more than one message). Write a clear title, a self-contained description for a worker
  agent that will do the work in a fresh session (include every relevant detail from the event — it will
  not see the event), and a short "ack" to post in Slack (a friendly one-line plan, no promises of timing).
- "reply": chit-chat, greetings, or a question you can fully answer in one Slack message. Put it in reply_text.
- "ignore": noise, messages not meant for you, work outside your responsibilities, or duplicates of an open
  task listed below.

Rules:
- Backlog items (source linear/github, kind backlog_item) were found proactively — nobody assigned them.
  Create a task if it falls within the playbook's responsibilities, otherwise ignore.
- Never create a task that duplicates one in the open-task list.
- Channel messages that are not addressed to you and not work requests: ignore.
- Keep Slack text short, plain and human. Use Slack mrkdwn, not Markdown headings.
- Fill every field; use "" for fields that don't apply to the chosen action.`;
}

function openTasksSummary(): string {
  const open = listTasks().filter((t) => t.status !== "done" && t.status !== "failed");
  if (open.length === 0) return "(none)";
  return open
    .slice(0, 30)
    .map((t) => `- [${t.status}] ${t.title}${t.source_ref ? ` (ref ${t.source_ref})` : ""}`)
    .join("\n");
}

async function askModel(event: EventRow, playbook: string): Promise<Decision> {
  const eventText = JSON.stringify(
    { source: event.source, kind: event.kind, payload: JSON.parse(event.payload) as unknown },
    null,
    2,
  );
  const response = await client().beta.messages.parse({
    model: config.anthropicModel,
    max_tokens: 4096,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: betaZodOutputFormat(TriageSchema) },
    system: systemPrompt(playbook),
    messages: [
      {
        role: "user",
        content: `<open_tasks>\n${openTasksSummary()}\n</open_tasks>\n\n<event>\n${eventText}\n</event>`,
      },
    ],
  });

  if (response.stop_reason === "refusal") {
    return { action: "ignore", reason: "model declined to triage this event" };
  }
  const out = response.parsed_output;
  if (!out) return { action: "ignore", reason: `unparseable triage (${response.stop_reason})` };

  if (out.action === "reply" && out.reply_text.trim()) {
    return { action: "reply", text: out.reply_text.trim() };
  }
  if (out.action === "create_task" && out.title.trim()) {
    return {
      action: "create_task",
      title: out.title.trim(),
      description: out.description.trim() || out.title.trim(),
      ack: out.ack.trim() || "On it.",
    };
  }
  return { action: "ignore", reason: out.reason || "nothing to do" };
}

/** Decides what to do with one inbox event, using the playbook as the agent's job description. */
export async function triage(event: EventRow, playbook: string | null): Promise<Decision> {
  if (event.source === "slack") {
    const p = parsePayload<SlackPayload>(event);
    // A reply in a thread where the agent asked a human something -> resume that task. No model call.
    // Applies to every Slack kind (an @mention inside the thread arrives as "slack.mention").
    if (p.thread_ts && p.thread_ts !== p.ts) {
      const q = findOpenQuestionByThread(p.channel, p.thread_ts);
      if (q) return { action: "answer_question", questionId: q.id };
    }
    if (!playbook) {
      if (event.kind === "slack.dm" || event.kind === "slack.mention") {
        return { action: "reply", text: NOT_ONBOARDED };
      }
      return { action: "ignore", reason: "not onboarded yet" };
    }
    if (!p.text?.trim()) return { action: "ignore", reason: "empty message" };
  } else if (event.kind === "backlog_item") {
    if (!playbook) return { action: "ignore", reason: "not onboarded yet" };
    const p = parsePayload<BacklogPayload>(event);
    const ref = backlogSourceRef(event, p);
    const existing = listTasks().find((t) => t.source_ref === ref);
    if (existing) return { action: "ignore", reason: `already tracked as task "${existing.title}"` };
  } else if (!playbook) {
    return { action: "ignore", reason: "not onboarded yet" };
  }
  return hasAnthropicKey() ? askModel(event, playbook) : ruleTriage(event);
}

// ---------- triage without an LLM (no ANTHROPIC_API_KEY): simple, predictable rules ----------

const hasAnthropicKey = () => Boolean(process.env.ANTHROPIC_API_KEY?.trim());

const WORK_RE =
  /\b(fix|bug|broken|crash|crashes|error|500|fail|failing|issue|please|pls|can you|could you|add|implement|make|update|change|refactor|investigate|look into|check)\b/i;

function ruleTriage(event: EventRow): Decision {
  if (event.kind === "backlog_item") {
    const p = parsePayload<BacklogPayload>(event);
    return {
      action: "create_task",
      title: p.title,
      description: `${p.description ?? p.body ?? ""}\n\n${p.url}`.trim(),
      ack: "",
    };
  }
  if (event.source !== "slack") return { action: "ignore", reason: "no rule for this event" };

  const text = parsePayload<SlackPayload>(event).text?.trim() ?? "";
  const greeting = /^(hi|hey|hello|yo|thanks|thank you|ok|cool|👋)\b[\s!.]*$/i.test(text);
  // A direct @mention with a real sentence is a request; plain channel chatter needs work keywords.
  const looksLikeWork =
    text.length > 12 && !greeting && (event.kind === "slack.mention" || WORK_RE.test(text));
  if (event.kind === "slack.thread_reply") return { action: "ignore", reason: "thread chatter" };
  if (looksLikeWork) {
    const firstLine = text.split("\n")[0];
    return {
      action: "create_task",
      title: short(firstLine, 90),
      description: text,
      ack: "On it 👀 I've opened a task and I'll report back in this thread.",
    };
  }
  if (event.kind === "slack.dm" || event.kind === "slack.mention") {
    return {
      action: "reply",
      text: "Hey! 👋 Tell me what needs doing (a bug, a change, something to check) and I'll pick it up.",
    };
  }
  return { action: "ignore", reason: "doesn't look like a work request" };
}

// ---------- applying decisions ----------

/** Swappable dependencies, so the dispatcher can be tested offline with mocks. */
export const deps = {
  triage,
  postMessage,
  addReaction,
  runTask,
  runningWorkers,
  createIssue,
  getPlaybook,
};

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function short(s: string, n = 80): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
}

/** Runs a Slack side effect; logs instead of throwing so the rest of the decision still applies. */
async function trySlack<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    logActivity("error", `Slack ${what} failed: ${errMsg(err)}`);
    return null;
  }
}

async function applyDecision(event: EventRow, d: Decision): Promise<void> {
  if (d.action === "ignore") {
    logActivity("decision", `Ignored ${event.kind}: ${d.reason}`);
    return;
  }

  if (d.action === "answer_question") {
    const p = parsePayload<SlackPayload>(event);
    const q = getDb().prepare(`SELECT * FROM questions WHERE id = ?`).get(d.questionId) as
      | { id: string; task_id: string; question: string }
      | undefined;
    if (!q) throw new Error(`question ${d.questionId} not found`);
    const answer = p.text ?? "";
    answerQuestion(q.id, answer);
    const task = getTask(q.task_id);
    // If the worker is still winding down (status "running"), sweepAnsweredTasks() requeues it later.
    if (task && task.status === "waiting_on_human") updateTask(task.id, { status: "queued" });
    logActivity("answer", `Human answered: ${short(answer, 200)}`, q.task_id);
    logActivity("decision", `Resuming task "${task?.title ?? q.task_id}" with the answer`, q.task_id);
    await trySlack("reaction", () => deps.addReaction(p.channel, p.ts, "white_check_mark"));
    return;
  }

  if (d.action === "reply") {
    if (event.source !== "slack") {
      logActivity("decision", `Nothing to post for ${event.kind}: ${short(d.text)}`);
      return;
    }
    const p = parsePayload<SlackPayload>(event);
    await deps.postMessage(p.channel, d.text, p.thread_ts ?? p.ts);
    logActivity("decision", `Replied in Slack: ${short(d.text)}`);
    return;
  }

  // create_task from a Slack message
  if (event.source === "slack") {
    const p = parsePayload<SlackPayload>(event);
    const threadTs = p.thread_ts ?? p.ts;
    await trySlack("reaction", () => deps.addReaction(p.channel, p.ts, "eyes"));
    await trySlack("ack", () => deps.postMessage(p.channel, d.ack, threadTs));

    let sourceRef = `slack:${p.channel}:${p.ts}`;
    let description = `${d.description}\n\nRequested in Slack by <@${p.user ?? "unknown"}>: "${p.text ?? ""}"`;
    try {
      const issue = await deps.createIssue(
        d.title,
        `${d.description}\n\n_Created by Übermensch from a Slack request._`,
      );
      sourceRef = issue.id;
      description += `\n\nLinear issue: ${issue.identifier} ${issue.url} (id ${issue.id})`;
    } catch (err) {
      logActivity("error", `Linear createIssue failed: ${errMsg(err)}`);
    }

    const task = createTask({
      title: d.title,
      description,
      source: "slack",
      sourceRef,
      slackChannel: p.channel,
      slackThreadTs: threadTs,
    });
    logActivity("decision", `New task from Slack: ${d.title}`, task.id);
    return;
  }

  // create_task from a backlog item (proactive pickup)
  const p = parsePayload<BacklogPayload>(event);
  const ref = backlogRef(event, p);
  const sourceRef = backlogSourceRef(event, p);
  if (listTasks().some((t) => t.source_ref === sourceRef)) {
    logActivity("decision", `Skipped ${ref}: already tracked`);
    return;
  }

  let slackChannel: string | null = null;
  let slackThreadTs: string | null = null;
  const announced = await trySlack("announcement", async () => {
    const channel = config.slack.defaultChannel();
    const msg = await deps.postMessage(
      channel,
      `Picking up ${ref}: ${p.title} — nobody's on it, so I am.\n${p.url}\n${d.ack}`,
    );
    return { channel, ts: msg.ts };
  });
  if (announced) {
    slackChannel = announced.channel;
    slackThreadTs = announced.ts;
  }

  const issueRef =
    event.source === "linear"
      ? `Linear issue ${ref} (id ${p.id}): ${p.url}`
      : `GitHub issue ${ref}: ${p.url}`;
  const task = createTask({
    title: `${ref}: ${d.title || p.title}`,
    description: `${d.description}\n\nPicked up proactively from the backlog.\n${issueRef}\n\nOriginal issue text:\n${p.description ?? p.body ?? ""}`,
    source: event.source,
    sourceRef,
    slackChannel,
    slackThreadTs,
  });
  logActivity("decision", `Proactively picked up ${ref}: ${p.title}`, task.id);
}

// ---------- dispatcher ----------

/** Tasks paused on a question that got answered while the worker was still running -> requeue. */
function sweepAnsweredTasks(): void {
  const rows = getDb()
    .prepare(
      `SELECT t.id FROM tasks t
       WHERE t.status = 'waiting_on_human'
         AND t.updated_at <= datetime('now', '-5 seconds')
         AND EXISTS (SELECT 1 FROM questions q WHERE q.task_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.task_id = t.id AND q.answer IS NULL)`,
    )
    .all() as { id: string }[];
  for (const r of rows) {
    updateTask(r.id, { status: "queued" });
    logActivity("decision", "Question already answered — resuming task", r.id);
  }
}

const inflight = new Set<string>();

function fillWorkerSlots(): void {
  while (Math.max(deps.runningWorkers(), inflight.size) < config.maxWorkers) {
    const task: TaskRow | null = claimNextQueuedTask();
    if (!task) break;
    inflight.add(task.id);
    logActivity("decision", `Worker started on: ${task.title}`, task.id);
    void Promise.resolve()
      .then(() => deps.runTask(task))
      .catch((err: unknown) => {
        // runTask should never throw; be defensive anyway.
        updateTask(task.id, { status: "failed", summary: `Worker crashed: ${errMsg(err)}` });
        logActivity("error", `Worker crashed: ${errMsg(err)}`, task.id);
      })
      .finally(() => inflight.delete(task.id));
  }
}

let ticking = false;

/** One dispatcher pass: triage + apply all pending events, then fill worker slots. */
export async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    for (const event of nextUnhandledEvents()) {
      const playbook = deps.getPlaybook();
      if (!playbook && event.kind === "backlog_item") {
        // Not hired yet: forget the item so the next heartbeat re-offers it after onboarding
        // (marking it handled would make the dedupe hide it forever).
        getDb().prepare(`DELETE FROM events WHERE id = ?`).run(event.id);
        continue;
      }
      try {
        const decision = await deps.triage(event, playbook);
        await applyDecision(event, decision);
      } catch (err) {
        console.error(`[brain] event ${event.id} (${event.kind}) failed:`, err);
        logActivity("error", `Failed to handle ${event.kind}: ${errMsg(err)}`);
      } finally {
        markEventHandled(event.id);
      }
    }
    try {
      sweepAnsweredTasks();
      fillWorkerSlots();
    } catch (err) {
      console.error("[brain] dispatch failed:", err);
      logActivity("error", `Dispatch failed: ${errMsg(err)}`);
    }
  } finally {
    ticking = false;
  }
}

let started = false;

/**
 * Every config.dispatchIntervalMs:
 *  1. nextUnhandledEvents() -> triage -> apply decision -> markEventHandled
 *     (answer_question: answerQuestion() + updateTask(taskId, { status: "queued" }) so the worker resumes)
 *  2. while running workers < config.maxWorkers: claimNextQueuedTask() -> runTask(task) (not awaited)
 */
export function startDispatcher(): void {
  if (started) return;
  started = true;
  setInterval(() => void tick(), config.dispatchIntervalMs);
}
