// WS3 — The coworker's own tools, exposed to each worker as an in-process MCP server.
// See docs/briefs/WS3-worker.md
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TaskRow } from "../src/lib/db";
import { createQuestion, getTask, logActivity, recall, remember, updateTask } from "../src/lib/db";
import { config } from "./config";
import { postMessage } from "./slack";
import { commentOnIssue, setIssueState } from "./sources/linear";
import { useComputer } from "./computer";

/** Name of the coworker MCP server; tools show up to the model as `mcp__coworker__<tool>`. */
export const COWORKER_SERVER = "coworker";
export const ASK_HUMAN_TOOL = `mcp__${COWORKER_SERVER}__ask_human`;

const MAX_PROGRESS_POSTS = 5; // the prompt asks for <= 3; this is the hard cap

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/** The task's Slack thread, creating one in SLACK_DEFAULT_CHANNEL (with a header post) if it has none. */
export async function ensureThread(
  task: TaskRow,
  header = `🧵 Working on: *${task.title}*`,
): Promise<{ channel: string; threadTs: string }> {
  const fresh = getTask(task.id) ?? task;
  if (fresh.slack_channel && fresh.slack_thread_ts) {
    return { channel: fresh.slack_channel, threadTs: fresh.slack_thread_ts };
  }
  const channel = fresh.slack_channel ?? config.slack.defaultChannel();
  const { ts } = await postMessage(channel, header);
  updateTask(task.id, { slack_channel: channel, slack_thread_ts: ts });
  return { channel, threadTs: ts };
}

/**
 * createSdkMcpServer({ name: "coworker", tools: [...] }) with tool(...) from the Agent SDK:
 *  - ask_human(question): post in the task's Slack thread, createQuestion(), status -> waiting_on_human,
 *    return "Question posted. Stop working now and end your turn; you will be resumed with the answer."
 *  - report_progress(text): post a short update in the task thread + logActivity("progress")
 *  - remember(fact) / recall(query): long-term memory across agents (src/lib/db)
 *  - linear_update(issue_id, state?, comment?): uses ./sources/linear
 *  - use_computer(goal): WS5 stretch, delegates to ./computer
 */
export function createCoworkerTools(task: TaskRow) {
  let progressPosts = 0;

  const askHuman = tool(
    "ask_human",
    "Ask your human manager a question in the task's Slack thread. Use it when you are blocked, when a " +
      "decision needs a human, or when your playbook says to ask first. After calling it you MUST stop " +
      "working and end your turn immediately; you will be resumed later with the answer.",
    { question: z.string().min(1).describe("One clear, self-contained question with the context needed to answer it") },
    async ({ question }) => {
      try {
        const { channel, threadTs } = await ensureThread(task);
        await postMessage(channel, `❓ ${question}`, threadTs);
        createQuestion({ taskId: task.id, slackChannel: channel, threadTs, question });
        updateTask(task.id, { status: "waiting_on_human" });
        logActivity("question", question, task.id);
        return ok(
          "Question posted. Stop working now and end your turn; you will be resumed with the answer.",
        );
      } catch (e) {
        logActivity("error", `ask_human failed: ${errMsg(e)}`, task.id);
        return fail(
          `Could not reach a human (${errMsg(e)}). Make the most reasonable, safe decision yourself, ` +
            `note the assumption in your final summary, and continue.`,
        );
      }
    },
  );

  const reportProgress = tool(
    "report_progress",
    "Post a one-line progress update in the task's Slack thread (e.g. root cause found, PR opened). " +
      "Use it at real milestones only, at most 3 times per task.",
    { text: z.string().min(1).describe("Short update, one or two sentences") },
    async ({ text }) => {
      logActivity("progress", text.slice(0, 300), task.id);
      if (++progressPosts > MAX_PROGRESS_POSTS) {
        return ok("Logged, but not posted to Slack: progress update limit reached. Keep working.");
      }
      try {
        const { channel, threadTs } = await ensureThread(task);
        await postMessage(channel, `🔧 ${text}`, threadTs);
        return ok("Posted.");
      } catch (e) {
        return ok(`Logged on the dashboard; Slack post failed (${errMsg(e)}). Keep working.`);
      }
    },
  );

  const rememberTool = tool(
    "remember",
    "Save a durable, non-obvious learning for future tasks (e.g. 'tests need `npm run db:seed` first', " +
      "'payments code lives in src/billing'). Not for task progress.",
    { fact: z.string().min(1).describe("The learning, phrased so it is useful out of context") },
    async ({ fact }) => {
      remember("learning", fact, task.id);
      logActivity("progress", `Learned: ${fact.slice(0, 280)}`, task.id);
      return ok("Remembered.");
    },
  );

  const recallTool = tool(
    "recall",
    "Search long-term memory (learnings and summaries of past tasks) by keywords.",
    { query: z.string().min(1).describe("Keywords to search for") },
    async ({ query }) => {
      const rows = recall(query, 10);
      if (rows.length === 0) return ok("Nothing relevant in memory.");
      return ok(rows.map((r) => `- [${r.kind}, ${r.created_at}] ${r.content}`).join("\n"));
    },
    { annotations: { readOnlyHint: true } },
  );

  const linearUpdate = tool(
    "linear_update",
    "Update a Linear issue: move it to a workflow state (e.g. 'In Progress', 'In Review', 'Done') " +
      "and/or add a comment (e.g. with the PR link).",
    {
      issue_id: z.string().min(1).describe("Linear issue id or identifier, e.g. ENG-12"),
      state: z.string().optional().describe("Workflow state name, e.g. 'In Progress' or 'Done'"),
      comment: z.string().optional().describe("Markdown comment to add"),
    },
    async ({ issue_id, state, comment }) => {
      if (!state && !comment) return fail("Pass state and/or comment.");
      const done: string[] = [];
      try {
        if (state) {
          await setIssueState(issue_id, state);
          done.push(`state -> ${state}`);
        }
        if (comment) {
          await commentOnIssue(issue_id, comment);
          done.push("comment added");
        }
        logActivity("tool", `Linear ${issue_id}: ${done.join(", ")}`, task.id);
        return ok(`Linear ${issue_id}: ${done.join(", ")}.`);
      } catch (e) {
        const partial = done.length ? ` (${done.join(", ")} succeeded)` : "";
        return fail(`Linear update failed${partial}: ${errMsg(e)}. Don't retry more than once.`);
      }
    },
  );

  const useComputerTool = tool(
    "use_computer",
    "Operate a desktop computer (screen, mouse, keyboard) to reach a goal in a GUI that has no API. " +
      "Slow; use only when no CLI, API or browser tool can do it.",
    { goal: z.string().min(1).describe("What to accomplish, with enough context to verify success") },
    async ({ goal }) => {
      try {
        return ok(await useComputer(goal));
      } catch (e) {
        return fail(`Computer use unavailable: ${errMsg(e)}`);
      }
    },
  );

  return createSdkMcpServer({
    name: COWORKER_SERVER,
    version: "1.0.0",
    alwaysLoad: true, // keep ask_human & co. visible instead of deferred behind tool search
    tools: [askHuman, reportProgress, rememberTool, recallTool, linearUpdate, useComputerTool],
  });
}
