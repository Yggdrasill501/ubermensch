// WS2 — Brain: triages inbox events and keeps worker slots full. See briefs/WS2-brain-heartbeat.md
import type { EventRow } from "../src/lib/db";

export type Decision =
  | { action: "ignore"; reason: string }
  | { action: "reply"; text: string } // quick answer in-thread, no task needed
  | { action: "create_task"; title: string; description: string; ack: string }
  | { action: "answer_question"; questionId: string }; // human replied to an ask_human thread

/** Decides what to do with one inbox event, using the playbook as the agent's job description. */
export async function triage(event: EventRow, playbook: string | null): Promise<Decision> {
  throw new Error("TODO WS2: triage");
}

/**
 * Every config.dispatchIntervalMs:
 *  1. nextUnhandledEvents() -> triage -> apply decision -> markEventHandled
 *     (answer_question: answerQuestion() + updateTask(taskId, { status: "queued" }) so the worker resumes)
 *  2. while running workers < config.maxWorkers: claimNextQueuedTask() -> runTask(task) (not awaited)
 */
export function startDispatcher(): void {
  throw new Error("TODO WS2: startDispatcher");
}
