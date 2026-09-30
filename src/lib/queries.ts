// Read-only helpers for the dashboard (WS4). Never write from here; db.ts owns mutations.
import { getDb, type MemoryRow, type QuestionRow } from "@/lib/db";

/** Learnings, task summaries and onboarding notes (everything but the playbook), newest first. */
export function listMemory(limit = 30): MemoryRow[] {
  return getDb()
    .prepare(`SELECT * FROM memory WHERE kind != 'playbook' ORDER BY id DESC LIMIT ?`)
    .all(limit) as MemoryRow[];
}

/** Recent questions the agent asked humans (open ones first). */
export function listQuestions(limit = 50): QuestionRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM questions ORDER BY (answer IS NULL) DESC, created_at DESC LIMIT ?`,
    )
    .all(limit) as QuestionRow[];
}

/** Timestamp of the newest activity or inbox event — a proxy for "is the daemon alive". */
export function lastSeenAt(): string | null {
  const row = getDb()
    .prepare(
      `SELECT max(ts) AS ts FROM (
         SELECT max(created_at) AS ts FROM activity
         UNION ALL SELECT max(created_at) FROM events
       )`,
    )
    .get() as { ts: string | null } | undefined;
  return row?.ts ?? null;
}

export type TaskPulse = { task_id: string; type: string; text: string; created_at: string };

/** Latest worker thought/tool line per task — what the running cards show as "now doing". */
export function latestTaskPulse(): Record<string, TaskPulse> {
  const rows = getDb()
    .prepare(
      `SELECT a.task_id, a.type, a.text, a.created_at FROM activity a
       JOIN (SELECT task_id, max(id) AS id FROM activity
             WHERE task_id IS NOT NULL AND type IN ('progress', 'tool') GROUP BY task_id) m
         ON a.id = m.id`,
    )
    .all() as TaskPulse[];
  return Object.fromEntries(rows.map((r) => [r.task_id, r]));
}

/** Task ids whose PR the daemon reported as merged (result lines end with "(merged …)"). */
export function mergedTaskIds(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT task_id FROM activity
       WHERE type = 'result' AND task_id IS NOT NULL AND text LIKE '%/pull/%' AND text LIKE '%(merged%'`,
    )
    .all() as { task_id: string }[];
  return rows.map((r) => r.task_id);
}
