// Shared state for the agent daemon (agent/) and the dashboard (src/app).
// This file is the contract between workstreams: change it only in WS0/integration.
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type EventSource = "slack" | "linear" | "github" | "heartbeat" | "dashboard";

export type TaskStatus =
  | "queued" // created, waiting for a worker slot
  | "running" // a worker agent is on it
  | "waiting_on_human" // asked a question in Slack, paused
  | "done"
  | "failed";

export type ActivityType =
  | "event" // something came into the inbox
  | "decision" // the brain triaged something
  | "message" // agent posted to Slack
  | "tool" // worker used a tool
  | "progress" // worker progress note
  | "question" // agent asked a human
  | "answer" // human answered
  | "result" // task finished (summary, PR link)
  | "error";

export interface EventRow {
  id: string;
  source: EventSource;
  external_id: string;
  kind: string;
  payload: string; // JSON
  created_at: string;
  handled_at: string | null;
}

export interface TaskRow {
  id: string;
  title: string;
  description: string;
  source: EventSource;
  source_ref: string | null; // e.g. Linear issue id, GitHub issue url, slack permalink
  slack_channel: string | null; // thread where the agent reports about this task
  slack_thread_ts: string | null;
  status: TaskStatus;
  session_id: string | null; // Agent SDK session id, used to resume after a human answers
  workspace: string | null; // local worktree path
  pr_url: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export interface ActivityRow {
  id: number;
  task_id: string | null;
  type: ActivityType;
  text: string;
  created_at: string;
}

export interface QuestionRow {
  id: string;
  task_id: string;
  slack_channel: string;
  thread_ts: string;
  question: string;
  answer: string | null;
  created_at: string;
  answered_at: string | null;
}

export interface MemoryRow {
  id: number;
  kind: "playbook" | "learning" | "task_summary" | "onboarding";
  key: string | null;
  content: string;
  created_at: string;
}

const DB_PATH = process.env.DB_PATH ?? path.join(process.cwd(), "data", "ubermensch.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL"); // dashboard reads while the daemon writes
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      handled_at TEXT
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      source TEXT NOT NULL,
      source_ref TEXT UNIQUE,
      slack_channel TEXT,
      slack_thread_ts TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      session_id TEXT,
      workspace TEXT,
      pr_url TEXT,
      summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      type TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      slack_channel TEXT NOT NULL,
      thread_ts TEXT NOT NULL,
      question TEXT NOT NULL,
      answer TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      answered_at TEXT
    );
    CREATE TABLE IF NOT EXISTS memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      key TEXT,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

// ---------- events (the inbox) ----------

/** Inserts an event; returns null if this external_id was already seen (dedupe). */
export function insertEvent(e: {
  source: EventSource;
  externalId: string;
  kind: string;
  payload: unknown;
}): EventRow | null {
  const id = randomUUID();
  const res = getDb()
    .prepare(
      `INSERT OR IGNORE INTO events (id, source, external_id, kind, payload) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, e.source, e.externalId, e.kind, JSON.stringify(e.payload));
  if (res.changes === 0) return null;
  return getDb().prepare(`SELECT * FROM events WHERE id = ?`).get(id) as EventRow;
}

export function nextUnhandledEvents(limit = 10): EventRow[] {
  return getDb()
    .prepare(`SELECT * FROM events WHERE handled_at IS NULL ORDER BY created_at LIMIT ?`)
    .all(limit) as EventRow[];
}

export function markEventHandled(id: string): void {
  getDb().prepare(`UPDATE events SET handled_at = datetime('now') WHERE id = ?`).run(id);
}

// ---------- tasks ----------

/** Creates a task; returns the existing one if source_ref was already taken (no double pickup). */
export function createTask(t: {
  title: string;
  description: string;
  source: EventSource;
  sourceRef?: string | null;
  slackChannel?: string | null;
  slackThreadTs?: string | null;
}): TaskRow {
  const d = getDb();
  if (t.sourceRef) {
    const existing = d.prepare(`SELECT * FROM tasks WHERE source_ref = ?`).get(t.sourceRef);
    if (existing) return existing as TaskRow;
  }
  const id = randomUUID();
  d.prepare(
    `INSERT INTO tasks (id, title, description, source, source_ref, slack_channel, slack_thread_ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    t.title,
    t.description,
    t.source,
    t.sourceRef ?? null,
    t.slackChannel ?? null,
    t.slackThreadTs ?? null,
  );
  return getTask(id)!;
}

export function getTask(id: string): TaskRow | undefined {
  return getDb().prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
}

export function listTasks(status?: TaskStatus): TaskRow[] {
  return (
    status
      ? getDb().prepare(`SELECT * FROM tasks WHERE status = ? ORDER BY updated_at DESC`).all(status)
      : getDb().prepare(`SELECT * FROM tasks ORDER BY updated_at DESC`).all()
  ) as TaskRow[];
}

export function updateTask(
  id: string,
  patch: Partial<Omit<TaskRow, "id" | "created_at" | "updated_at">>,
): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = @${k}`).join(", ");
  getDb()
    .prepare(`UPDATE tasks SET ${sets}, updated_at = datetime('now') WHERE id = @id`)
    .run({ ...patch, id });
}

/** Atomically moves one queued task to running. Returns it, or null if none. */
export function claimNextQueuedTask(): TaskRow | null {
  const d = getDb();
  return d.transaction(() => {
    const t = d
      .prepare(`SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at LIMIT 1`)
      .get() as TaskRow | undefined;
    if (!t) return null;
    d.prepare(`UPDATE tasks SET status = 'running', updated_at = datetime('now') WHERE id = ?`).run(
      t.id,
    );
    return { ...t, status: "running" as const };
  })();
}

// ---------- activity (dashboard feed) ----------

export function logActivity(type: ActivityType, text: string, taskId?: string | null): void {
  getDb()
    .prepare(`INSERT INTO activity (task_id, type, text) VALUES (?, ?, ?)`)
    .run(taskId ?? null, type, text);
}

export function recentActivity(limit = 100, taskId?: string): ActivityRow[] {
  return (
    taskId
      ? getDb()
          .prepare(`SELECT * FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT ?`)
          .all(taskId, limit)
      : getDb().prepare(`SELECT * FROM activity ORDER BY id DESC LIMIT ?`).all(limit)
  ) as ActivityRow[];
}

// ---------- questions (ask_human pause/resume) ----------

export function createQuestion(q: {
  taskId: string;
  slackChannel: string;
  threadTs: string;
  question: string;
}): QuestionRow {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO questions (id, task_id, slack_channel, thread_ts, question) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, q.taskId, q.slackChannel, q.threadTs, q.question);
  return getDb().prepare(`SELECT * FROM questions WHERE id = ?`).get(id) as QuestionRow;
}

/** Finds the open question in a Slack thread, so a human reply can resume its task. */
export function findOpenQuestionByThread(channel: string, threadTs: string): QuestionRow | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM questions WHERE slack_channel = ? AND thread_ts = ? AND answer IS NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(channel, threadTs) as QuestionRow | undefined;
}

export function answerQuestion(id: string, answer: string): void {
  getDb()
    .prepare(`UPDATE questions SET answer = ?, answered_at = datetime('now') WHERE id = ?`)
    .run(answer, id);
}

// ---------- memory (playbook + learnings) ----------

export function getPlaybook(): string | null {
  const row = getDb()
    .prepare(`SELECT content FROM memory WHERE kind = 'playbook' ORDER BY id DESC LIMIT 1`)
    .get() as { content: string } | undefined;
  return row?.content ?? null;
}

/** Appends a new playbook version; the latest one wins. */
export function setPlaybook(content: string): void {
  getDb().prepare(`INSERT INTO memory (kind, content) VALUES ('playbook', ?)`).run(content);
}

export function remember(kind: MemoryRow["kind"], content: string, key?: string): void {
  getDb()
    .prepare(`INSERT INTO memory (kind, key, content) VALUES (?, ?, ?)`)
    .run(kind, key ?? null, content);
}

/** Naive recall: keyword LIKE match over learnings and task summaries, newest first. */
export function recall(query: string, limit = 10): MemoryRow[] {
  const words = query
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length > 3)
    .slice(0, 6);
  if (words.length === 0) {
    return getDb()
      .prepare(`SELECT * FROM memory WHERE kind != 'playbook' ORDER BY id DESC LIMIT ?`)
      .all(limit) as MemoryRow[];
  }
  const where = words.map(() => `lower(content) LIKE ?`).join(" OR ");
  return getDb()
    .prepare(
      `SELECT * FROM memory WHERE kind != 'playbook' AND (${where}) ORDER BY id DESC LIMIT ?`,
    )
    .all(...words.map((w) => `%${w}%`), limit) as MemoryRow[];
}
