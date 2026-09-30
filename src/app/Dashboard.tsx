"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type Ref, type RefObject } from "react";
import type { ActivityRow, MemoryRow, QuestionRow, TaskRow } from "@/lib/db";
import type { TaskPulse } from "@/lib/queries";

// ---------- demo copy (edit for the stage) ----------

const NAME = "Übermensch";
const GIVE_WORK = {
  linearLabel: "ubermensch",
  slackHandle: "@ubermensch",
  slackChannel: "#all-cursorhackdemo",
};
const SHIPPED_LIMIT = 5;

// ---------- data ----------

type State = {
  tasks: TaskRow[];
  activity: ActivityRow[];
  playbook: string | null;
  memory: MemoryRow[];
  questions: QuestionRow[];
  pulse: Record<string, TaskPulse>;
  merged: string[];
  lastSeenAt: string | null;
  now: string;
};

const POLL_MS = 2000;
const ONLINE_WINDOW_MS = 10 * 60 * 1000;
const HEARTBEAT_NOISE = /^Heartbeat: checked backlog \(0 new\)/;

// ---------- helpers ----------

/** SQLite `datetime('now')` is UTC without a zone marker: "2026-09-30 12:34:56". */
function parseTs(s: string | null | undefined): number {
  if (!s) return NaN;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z");
}

function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function fmtAgo(ts: string | null | undefined, now: number): string {
  const t = parseTs(ts);
  if (!Number.isFinite(t) || !now) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function roleFromPlaybook(playbook: string | null): string | null {
  if (!playbook) return null;
  const m = playbook.match(/^\s*#{1,6}\s+(.+?)\s*#*\s*$/m);
  if (!m) return null;
  // "Playbook: BackendDev, you gonna own the backend…" → "BackendDev"
  const role = m[1].replace(/^playbook\s*[:—–-]\s*/i, "").split(/[,.;(]|\s[—–-]\s/)[0].trim();
  return role.length > 42 ? role.slice(0, 40) + "…" : role || null;
}

function prLabel(url: string): string {
  const m = url.match(/\/pull\/(\d+)/);
  return m ? `PR #${m[1]}` : "PR";
}

/** Plain text for the big screen: no emoji markers, Slack mrkdwn or raw URLs. */
function clean(text: string): string {
  return text
    .replace(/^\p{Extended_Pictographic}️?\s*/u, "")
    .replace(/:?\s*https?:\/\/cursor\.com\/agents\/\S+/g, "")
    .replace(/<@(\w+)>/g, "@someone")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/https?:\/\/\S+/g, (u) => (u.includes("/pull/") ? prLabel(u) : u.includes("cursor.com/agents/") ? "Cursor" : u.replace(/^https?:\/\//, "")));
}

// ---------- main ----------

export default function Dashboard() {
  const [state, setState] = useState<State | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);
  const [activityOpen, setActivityOpen] = useState(false);
  const [showAllShipped, setShowAllShipped] = useState(false);
  const playbookRef = useRef<HTMLDialogElement>(null);
  const memoryRef = useRef<HTMLDialogElement>(null);
  const newTaskRef = useRef<HTMLDialogElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState((await res.json()) as State);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const poll = setInterval(refresh, POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearTimeout(first);
      clearInterval(poll);
      clearInterval(tick);
    };
  }, [refresh]);

  const openQuestionByTask = useMemo(() => {
    const m = new Map<string, QuestionRow>();
    for (const q of state?.questions ?? []) {
      if (q.answer == null && !m.has(q.task_id)) m.set(q.task_id, q);
    }
    return m;
  }, [state?.questions]);

  const mergedSet = useMemo(() => new Set(state?.merged ?? []), [state?.merged]);

  if (!state) {
    return (
      <main className="flex flex-1 items-center justify-center text-xl text-base-content/50">
        {error ? `Can’t reach the daemon (${error})` : "Waking up…"}
      </main>
    );
  }

  const { tasks, activity, playbook, memory } = state;
  const role = roleFromPlaybook(playbook);
  const lastSeen = parseTs(state.lastSeenAt);
  const online = !error && Number.isFinite(lastSeen) && now - lastSeen < ONLINE_WINDOW_MS;

  const byOldest = (a: TaskRow, b: TaskRow) => parseTs(a.created_at) - parseTs(b.created_at);
  const working = tasks.filter((t) => t.status === "running").sort(byOldest);
  const waiting = tasks.filter((t) => t.status === "waiting_on_human").sort(byOldest);
  const queued = tasks.filter((t) => t.status === "queued").sort(byOldest);
  const shipped = tasks.filter((t) => t.status === "done" || t.status === "failed"); // newest first from the API
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const active = [...working, ...waiting];
  const isEmpty = tasks.length === 0;
  const feed = activity.filter((a) => !HEARTBEAT_NOISE.test(a.text)).slice(0, 40);

  return (
    <div className="flex min-h-screen flex-col text-xl">
      {/* ---------- header: one line ---------- */}
      <header className="mx-auto flex w-full max-w-6xl items-baseline gap-4 px-8 pt-10 2xl:px-0">
        <span
          className={`dot relative -top-0.5 ${online ? "dot-live text-success" : "text-base-content/30"}`}
          title={online ? "online" : "idle"}
        />
        <h1 className="font-semibold tracking-tight">
          {NAME}
          {role && <span className="font-normal text-base-content/45"> · {role}</span>}
        </h1>
        <span className="flex-1" />
        <p className="hidden text-base-content/45 tabular-nums sm:block">
          <Num n={working.length} /> working · <Num n={waiting.length} warn={waiting.length > 0} /> waiting ·{" "}
          <Num n={doneCount} /> shipped
        </p>
        <button
          className={`text-base transition-colors hover:text-base-content ${activityOpen ? "text-primary" : "text-base-content/45"}`}
          onClick={() => setActivityOpen((o) => !o)}
        >
          Activity
        </button>
        <div className="dropdown dropdown-end">
          <button tabIndex={0} className="px-1 text-base-content/45 hover:text-base-content" aria-label="More">
            ···
          </button>
          <ul tabIndex={0} className="dropdown-content menu z-30 mt-3 w-48 rounded-box bg-base-200 p-2 text-base shadow-xl">
            <li>
              <button onClick={() => newTaskRef.current?.showModal()}>New task</button>
            </li>
            <li>
              <button onClick={() => playbookRef.current?.showModal()}>Playbook</button>
            </li>
            <li>
              <button onClick={() => memoryRef.current?.showModal()}>Memory</button>
            </li>
          </ul>
        </div>
      </header>

      {/* ---------- how to give it work: one quiet line ---------- */}
      {!isEmpty && (
        <p className="mx-auto w-full max-w-6xl px-8 pt-2 text-base text-base-content/40 2xl:px-0">
          <GiveWorkLine />
        </p>
      )}

      <div className="mx-auto flex w-full max-w-6xl flex-1 gap-16 px-8 2xl:px-0">
        <main className="flex min-w-0 flex-1 flex-col">
          {isEmpty ? (
            <EmptyState hired={!!playbook} />
          ) : (
            <>
              {/* ---------- now ---------- */}
              <section className="pt-16">
                <SectionLabel>Now</SectionLabel>
                {active.length === 0 ? (
                  <p className="py-6 text-base-content/40">Nothing in progress — give me work.</p>
                ) : (
                  <div className="flex flex-col gap-6">
                    {active.map((t) => (
                      <NowCard
                        key={t.id}
                        task={t}
                        now={now}
                        pulse={state.pulse?.[t.id]}
                        question={openQuestionByTask.get(t.id)}
                      />
                    ))}
                  </div>
                )}
                {queued.length > 0 && (
                  <p className="truncate pt-6 text-base text-base-content/45">
                    {queued.length} queued
                    <span className="text-base-content/30"> — {queued.map((t) => t.title).join(" · ")}</span>
                  </p>
                )}
              </section>

              {/* ---------- shipped ---------- */}
              {shipped.length > 0 && (
                <section className="pt-16 pb-16">
                  <SectionLabel>Shipped</SectionLabel>
                  <ul className="flex flex-col">
                    {(showAllShipped ? shipped : shipped.slice(0, SHIPPED_LIMIT)).map((t) => (
                      <ShippedRow key={t.id} task={t} merged={mergedSet.has(t.id)} />
                    ))}
                  </ul>
                  {shipped.length > SHIPPED_LIMIT && (
                    <button
                      className="pt-3 text-base text-base-content/40 hover:text-base-content"
                      onClick={() => setShowAllShipped((v) => !v)}
                    >
                      {showAllShipped ? "Show less" : `${shipped.length - SHIPPED_LIMIT} older`}
                    </button>
                  )}
                </section>
              )}
            </>
          )}
        </main>

        {/* ---------- activity: tucked away until asked for ---------- */}
        {activityOpen && (
          <aside className="fade-in hidden w-96 shrink-0 pt-16 lg:block">
            <SectionLabel>Activity</SectionLabel>
            <ol className="flex max-h-[calc(100vh-14rem)] flex-col gap-4 overflow-y-auto pr-2 text-base">
              {feed.length === 0 && <li className="text-base-content/40">Nothing yet</li>}
              {feed.map((a) => (
                <li key={a.id} className="flex gap-3">
                  <span className="w-16 shrink-0 text-base-content/30 tabular-nums">{fmtAgo(a.created_at, now).replace(" ago", "")}</span>
                  <span
                    className={`line-clamp-2 min-w-0 ${
                      a.type === "error" ? "text-error/80" : a.type === "question" ? "text-warning/80" : "text-base-content/55"
                    }`}
                  >
                    {clean(a.text)}
                  </span>
                </li>
              ))}
            </ol>
          </aside>
        )}
      </div>

      <PlaybookModal ref={playbookRef} playbook={playbook} />
      <MemoryModal ref={memoryRef} memory={memory} />
      <NewTaskModal ref={newTaskRef} onCreated={refresh} />
    </div>
  );
}

// ---------- pieces ----------

function Num({ n, warn }: { n: number; warn?: boolean }) {
  return <span className={warn ? "text-warning" : "text-base-content"}>{n}</span>;
}

function SectionLabel({ children }: { children: string }) {
  return <h2 className="pb-6 text-base font-medium tracking-widest text-base-content/35 uppercase">{children}</h2>;
}

function GiveWorkLine() {
  return (
    <>
      Give me work → label a Linear ticket <span className="font-mono text-primary">{GIVE_WORK.linearLabel}</span> ·{" "}
      <span className="font-mono text-primary">{GIVE_WORK.slackHandle}</span> in Slack {GIVE_WORK.slackChannel}
    </>
  );
}

function EmptyState({ hired }: { hired: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-5 pb-24 text-center">
      <p className="text-4xl font-semibold tracking-tight">
        {hired ? "Nothing on my plate yet." : "Not hired yet."}
      </p>
      <p className="text-xl text-base-content/50">
        {hired ? (
          <GiveWorkLine />
        ) : (
          <>
            DM <span className="font-mono text-primary">{GIVE_WORK.slackHandle}</span> “you’re hired” in Slack to start
            onboarding.
          </>
        )}
      </p>
    </div>
  );
}

function NowCard({
  task,
  now,
  pulse,
  question,
}: {
  task: TaskRow;
  now: number;
  pulse?: TaskPulse;
  question?: QuestionRow;
}) {
  const waiting = task.status === "waiting_on_human";
  const since = parseTs(task.updated_at);
  const cursorAgent = task.session_id?.startsWith("bc-") ? task.session_id : null;
  const line = waiting
    ? question?.question ?? "Waiting for a reply in Slack"
    : pulse
      ? clean(pulse.text)
      : "Starting a Cursor agent…";

  return (
    <article className="fade-in rounded-box bg-base-200 px-10 py-8">
      <div className="flex items-baseline gap-4">
        <span className={`dot relative -top-1.5 dot-live ${waiting ? "text-warning" : "text-primary"}`} />
        <h3 className="min-w-0 flex-1 text-4xl leading-tight font-semibold tracking-tight">{task.title}</h3>
        <span className="shrink-0 text-xl text-base-content/40 tabular-nums">{fmtDuration(now - since)}</span>
      </div>
      <div className="flex items-baseline gap-6 pt-4 pl-6">
        <p
          key={line}
          className={`fade-in min-w-0 flex-1 truncate ${
            waiting ? "text-warning" : pulse?.type === "tool" ? "font-mono text-base-content/50" : "text-base-content/60"
          }`}
        >
          {waiting && <span className="text-warning/60">Asked: </span>}
          {line}
        </p>
        {cursorAgent && <ExtLink href={`https://cursor.com/agents/${cursorAgent}`}>Cursor ↗</ExtLink>}
        {task.pr_url && <ExtLink href={task.pr_url}>{prLabel(task.pr_url)} ↗</ExtLink>}
      </div>
    </article>
  );
}

function ShippedRow({ task, merged }: { task: TaskRow; merged: boolean }) {
  const failed = task.status === "failed";
  const took = parseTs(task.updated_at) - parseTs(task.created_at);
  return (
    <li className="fade-in flex items-baseline gap-4 py-3">
      <span className={`dot relative -top-0.5 ${failed ? "text-error" : "text-success"}`} />
      <span className={`min-w-0 flex-1 truncate ${failed ? "text-base-content/50" : ""}`}>{task.title}</span>
      {task.pr_url ? (
        <ExtLink href={task.pr_url}>
          {prLabel(task.pr_url)}
          {merged ? " merged" : ""} ↗
        </ExtLink>
      ) : (
        <span className="text-base text-base-content/35">{failed ? "failed" : "no PR"}</span>
      )}
      <span className="w-24 shrink-0 text-right text-base text-base-content/35 tabular-nums">{fmtDuration(took)}</span>
    </li>
  );
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="shrink-0 text-base text-base-content/45 transition-colors hover:text-primary"
    >
      {children}
    </a>
  );
}

function Modal({ ref, title, children }: { ref: Ref<HTMLDialogElement>; title: string; children: React.ReactNode }) {
  return (
    <dialog ref={ref} className="modal">
      <div className="modal-box max-w-3xl bg-base-200 p-10">
        <h3 className="pb-6 text-base font-medium tracking-widest text-base-content/40 uppercase">{title}</h3>
        {children}
      </div>
      <form method="dialog" className="modal-backdrop">
        <button>close</button>
      </form>
    </dialog>
  );
}

function PlaybookModal({ ref, playbook }: { ref: Ref<HTMLDialogElement>; playbook: string | null }) {
  return (
    <Modal ref={ref} title="Playbook">
      {playbook ? (
        <pre className="max-h-[70vh] overflow-y-auto font-sans text-xl leading-relaxed whitespace-pre-wrap">{playbook}</pre>
      ) : (
        <p className="text-xl text-base-content/50">
          No playbook yet — DM {GIVE_WORK.slackHandle} “you’re hired” in Slack.
        </p>
      )}
    </Modal>
  );
}

function MemoryModal({ ref, memory }: { ref: Ref<HTMLDialogElement>; memory: MemoryRow[] }) {
  return (
    <Modal ref={ref} title="Memory">
      {memory.length === 0 ? (
        <p className="text-xl text-base-content/50">Nothing learned yet.</p>
      ) : (
        <ul className="flex max-h-[70vh] flex-col gap-5 overflow-y-auto">
          {memory.map((m) => (
            <li key={m.id}>
              <span className="text-base text-base-content/35">{m.kind.replace("_", " ")}</span>
              <p className="text-xl">{clean(m.content)}</p>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function NewTaskModal({ ref, onCreated }: { ref: RefObject<HTMLDialogElement | null>; onCreated: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const fd = new FormData(form);
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: fd.get("title"), description: fd.get("description") }),
      });
      if (!res.ok)
        throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`);
      form.reset();
      ref.current?.close();
      onCreated();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal ref={ref} title="New task">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <input
          name="title"
          required
          autoFocus
          placeholder="What should it do?"
          className="input input-lg w-full border-0 bg-base-100"
        />
        <textarea
          name="description"
          rows={4}
          placeholder="Details (optional)"
          className="textarea textarea-lg w-full border-0 bg-base-100"
        />
        {err && <p className="text-base text-error">{err}</p>}
        <div className="flex justify-end gap-3 pt-2">
          <button type="button" className="btn btn-ghost" onClick={() => ref.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy && <span className="loading loading-spinner loading-sm" />} Queue it
          </button>
        </div>
      </form>
    </Modal>
  );
}
