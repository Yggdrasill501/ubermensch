// WS3 — The coworker's own tools, exposed to each worker as an in-process MCP server.
// See briefs/WS3-worker.md
import type { TaskRow } from "../src/lib/db";

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
  throw new Error("TODO WS3: createCoworkerTools");
}
