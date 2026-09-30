// WS1 — Onboarding: the agent interviews its manager in a Slack DM and writes its own playbook.
// See docs/briefs/WS1-slack-onboarding.md
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { config } from "./config";
import { getDb, logActivity, remember, setPlaybook } from "../src/lib/db";
import { postMessage } from "./slack";

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

interface Interview {
  channel: string;
  manager: string; // Slack user id of the person hiring us
  messages: BetaMessageParam[]; // append-only API history (keeps thinking blocks valid)
  transcript: string[]; // human-readable log, persisted to memory at the end
  answers: number;
  finishing: boolean;
  queue: Promise<void>; // serializes turns for this DM
}

const interviews = new Map<string, Interview>();
const MAX_ANSWERS = 8; // hard stop even if the model keeps asking

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  client ??= new Anthropic();
  return client;
}

// Server-side refusal fallback (Opus 5.5 default per the claude-api skill).
const FALLBACK = {
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default" as const,
};

const INTERVIEW_SYSTEM = `You are Übermensch, an autonomous AI coworker on your first day at a new job. \
You live in the team's Slack, Linear and GitHub, pick up work on your own, and ask humans only when stuck. \
The person messaging you in this Slack DM just hired you and is your manager. Interview them to learn your role.

How to interview:
- Ask ONE question per message. Aim for about 5-6 questions total, never more than 7.
- Cover, in roughly this order: (1) your role and what they want to call you, (2) what you own and what "done" \
means, (3) where work comes from: which GitHub repos, Linear team, Slack channels, (4) how autonomous to be: \
may you merge PRs, deploy, close issues on your own, (5) when to stop and ask for help, and whom, \
(6) working style and tone (how chatty, how to report progress).
- Skip anything they already answered. Combine topics if an answer covers several.
- Answers may be long, rambling, dictated voice transcripts. Pull out what matters; never ask them to repeat.
- Be warm, brief and human, like a sharp new hire. Use Slack mrkdwn (*bold*, bullet lists), no headings.
- Your very first message: a one-line thank-you for hiring you, then your first question.
- If they say "that's enough", "just start", or similar, finish immediately.

Output: set "message" to what you send in Slack. Set "interview_complete" to true only once you have enough to \
write your job playbook; in that case "message" is a short thanks saying you'll write up your playbook now \
(no question).`;

const PLAYBOOK_SYSTEM = `You are Übermensch, an autonomous AI coworker. You just finished an onboarding \
interview with your new manager. Write your own job playbook: the document every future version of you reads \
before doing any work. Write it in first person, concrete and specific to what the manager said. Where they \
were silent, choose sensible, safe defaults and mark them "(default)".

playbook_markdown: Markdown with exactly these H2 sections, in order:
## Identity
## Responsibilities
## Where work comes from
## How I work
## Autonomy & guardrails
## When I ask for help
## Team
Start with a single H1 title line like "# Playbook: <name>, <role>". Use bullet lists. Include concrete repos, \
Linear team keys, channel names and people exactly as given (keep Slack mentions like <@U123> verbatim).

summary: a Slack mrkdwn message (max ~8 short lines) to the manager summarizing what you understood: \
role, what you own, where you'll look for work, your guardrails. No closing line; that is added separately.`;

const TurnSchema = z.object({
  message: z.string(),
  interview_complete: z.boolean(),
});

const PlaybookSchema = z.object({
  playbook_markdown: z.string(),
  summary: z.string(),
});

/** True while an onboarding interview is in progress in this DM channel. */
export function isOnboarding(channel: string): boolean {
  return interviews.has(channel) || loadState(channel) !== undefined;
}

/**
 * Starts ("you're hired", "onboard", "/hire") or continues the interview.
 * When the agent has enough info it writes the playbook via setPlaybook() and says so.
 */
export async function handleOnboardingMessage(msg: {
  channel: string;
  user: string;
  text: string;
  ts: string;
}): Promise<void> {
  let iv = interviews.get(msg.channel) ?? loadState(msg.channel);
  if (!iv) {
    iv = {
      channel: msg.channel,
      manager: msg.user,
      messages: [],
      transcript: [],
      answers: 0,
      finishing: false,
      queue: Promise.resolve(),
    };
    interviews.set(msg.channel, iv);
    saveState(iv);
    logActivity("event", `Onboarding interview started by <@${msg.user}>`);
  }
  const current = iv;
  // Serialize: a second message sent while the model is thinking waits its turn.
  const turn = current.queue.then(() => runTurn(current, msg));
  current.queue = turn.catch(() => undefined);
  return turn;
}

async function runTurn(iv: Interview, msg: { user: string; text: string }): Promise<void> {
  if (iv.finishing) return; // already writing the playbook; ignore stragglers
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return scriptedTurn(iv, msg);

  const isFirst = iv.messages.length === 0;
  iv.messages.push({ role: "user", content: `<@${msg.user}>: ${msg.text}` });
  iv.transcript.push(`Manager (<@${msg.user}>): ${msg.text}`);
  if (!isFirst) iv.answers += 1;

  if (iv.answers >= MAX_ANSWERS) {
    await finish(iv);
    return;
  }

  let reply: z.infer<typeof TurnSchema>;
  try {
    const response = await anthropic().beta.messages.parse({
      model: config.anthropicModel,
      max_tokens: 4000,
      system: INTERVIEW_SYSTEM,
      messages: iv.messages,
      output_config: { effort: "low", format: betaZodOutputFormat(TurnSchema) },
      ...FALLBACK,
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      throw new Error(`no usable reply (stop_reason=${response.stop_reason})`);
    }
    // Append the full assistant turn (minus SDK-only parsed fields) so history stays append-only.
    iv.messages.push({ role: "assistant", content: toParams(response.content) });
    reply = response.parsed_output;
  } catch (err) {
    console.error("[onboarding] interview turn failed", err);
    logActivity("error", `Onboarding turn failed: ${errMsg(err)}`);
    await postMessage(iv.channel, "Sorry, my brain glitched for a second. Could you send that again?");
    return;
  }

  iv.transcript.push(`Übermensch: ${reply.message}`);
  await postMessage(iv.channel, reply.message);
  saveState(iv);

  if (reply.interview_complete) await finish(iv);
}

async function finish(iv: Interview): Promise<void> {
  iv.finishing = true;
  const transcript = iv.transcript.join("\n\n");
  try {
    await postMessage(iv.channel, "_Writing my playbook…_ :memo:");
    const stream = anthropic().beta.messages.stream({
      model: config.anthropicModel,
      max_tokens: 32000,
      system: PLAYBOOK_SYSTEM,
      messages: [
        {
          role: "user",
          content: `Onboarding interview transcript:\n\n<transcript>\n${transcript}\n</transcript>`,
        },
      ],
      output_config: { effort: "medium", format: betaZodOutputFormat(PlaybookSchema) },
      ...FALLBACK,
    });
    const response = await stream.finalMessage();
    const parsed = response.parsed_output;
    if (response.stop_reason === "refusal" || !parsed) {
      throw new Error(`no playbook (stop_reason=${response.stop_reason})`);
    }

    setPlaybook(parsed.playbook_markdown);
    remember("onboarding", transcript, iv.channel);
    logActivity("result", "Onboarding complete: playbook written");
    interviews.delete(iv.channel);
    clearState(iv.channel);

    await postMessage(
      iv.channel,
      `${parsed.summary}\n\nI'm starting now. I'll check the backlog every few minutes.`,
    );
  } catch (err) {
    console.error("[onboarding] playbook generation failed", err);
    logActivity("error", `Playbook generation failed: ${errMsg(err)}`);
    iv.finishing = false; // let the next DM retry finishing
    iv.answers = MAX_ANSWERS - 1;
    await postMessage(
      iv.channel,
      "I couldn't write my playbook just now. Send me any message and I'll try again.",
    ).catch(() => undefined);
  }
}

/** Converts parsed response blocks back to request params (drops the SDK-added `parsed_output`). */
function toParams(content: Anthropic.Beta.BetaContentBlock[]): BetaContentBlockParam[] {
  return content.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    return block as unknown as BetaContentBlockParam;
  });
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------- scripted interview (no ANTHROPIC_API_KEY): fixed questions, template playbook ----------

const SCRIPT: { key: string; q: string }[] = [
  { key: "role", q: "Thanks for hiring me! 🙌 First: what should I be called, and what's my role?" },
  { key: "owns", q: "What do I own, and what does *done* look like for my work?" },
  { key: "sources", q: "Where does my work come from? (GitHub repos, Linear team, Slack channels)" },
  { key: "autonomy", q: "How autonomous should I be? Can I merge PRs, close issues, deploy on my own?" },
  { key: "help", q: "When should I stop and ask for help, and who should I ask?" },
  { key: "style", q: "Last one: how should I work and report progress (tone, how chatty)?" },
];
const scripted = new Map<string, string[]>(); // channel -> answers so far
const DONE_RE = /\b(that'?s enough|just start|skip|go ahead and start)\b/i;

async function scriptedTurn(iv: Interview, msg: { user: string; text: string }): Promise<void> {
  iv.transcript.push(`Manager (<@${msg.user}>): ${msg.text}`);
  let answers = scripted.get(iv.channel);
  if (!answers) {
    scripted.set(iv.channel, (answers = [])); // first message is the "you're hired" trigger
  } else {
    answers.push(msg.text.trim());
  }
  if (answers.length >= SCRIPT.length || (answers.length > 0 && DONE_RE.test(msg.text))) {
    iv.finishing = true;
    const md = scriptedPlaybook(answers);
    setPlaybook(md);
    remember("onboarding", iv.transcript.join("\n\n"), iv.channel);
    logActivity("result", "Onboarding complete: playbook written (scripted mode)");
    interviews.delete(iv.channel);
    clearState(iv.channel);
    scripted.delete(iv.channel);
    const bullets = SCRIPT.map((s, i) => (answers[i] ? `• *${s.key}*: ${oneLine(answers[i], 140)}` : ""))
      .filter(Boolean)
      .join("\n");
    await postMessage(
      iv.channel,
      `Got it, here's what I understood:\n${bullets}\n\nI'm starting now. I'll check the backlog every few minutes.`,
    );
    return;
  }
  const next = SCRIPT[answers.length].q;
  iv.transcript.push(`Übermensch: ${next}`);
  await postMessage(iv.channel, next);
  saveState(iv);
}

function scriptedPlaybook(a: string[]): string {
  const or = (i: number, fallback: string) => (a[i]?.trim() ? a[i].trim() : `${fallback} (default)`);
  // "BackendDev, you gonna own the backend…" -> "BackendDev"
  const name = oneLine((a[0] ?? "Übermensch").split(/[,.;:\n—–-]/)[0] || "Übermensch", 40);
  return `# Playbook: ${name}

## Identity
- ${or(0, "Übermensch, an autonomous software engineer on the team")}

## Responsibilities
- ${or(1, "Fix bugs and ship small improvements end to end; done = merged PR with passing tests")}

## Where work comes from
- ${or(2, "Slack requests in the team channel, the Linear backlog, and GitHub issues")}
- GitHub repo: ${process.env.GITHUB_REPO ?? "(not set)"} · Linear team: ${process.env.LINEAR_TEAM_KEY ?? "(not set)"}

## How I work
- ${or(5, "Short, friendly updates in the task's Slack thread; a summary when done")}

## Autonomy & guardrails
- ${or(3, "Open PRs and merge them when CI is green; never deploy without asking")}
- Always follow the repo's CLAUDE.md / README rules (e.g. ask before touching payments code).

## When I ask for help
- ${or(4, "When requirements are unclear, when a change is risky, or when the repo says a human must approve")}

## Team
- Manager: the person who onboarded me in Slack.
`;
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// ---------- persistence: an interview survives daemon restarts ----------

function stateTable() {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS interview_state (channel TEXT PRIMARY KEY, data TEXT NOT NULL)`);
  return db;
}

function saveState(iv: Interview): void {
  const data = {
    manager: iv.manager,
    messages: iv.messages,
    transcript: iv.transcript,
    answers: iv.answers,
    scripted: scripted.get(iv.channel) ?? null,
  };
  stateTable()
    .prepare(`INSERT OR REPLACE INTO interview_state (channel, data) VALUES (?, ?)`)
    .run(iv.channel, JSON.stringify(data));
}

function clearState(channel: string): void {
  stateTable().prepare(`DELETE FROM interview_state WHERE channel = ?`).run(channel);
}

/** Restores an interview that was in progress before a restart (and caches it in memory). */
function loadState(channel: string): Interview | undefined {
  const row = stateTable()
    .prepare(`SELECT data FROM interview_state WHERE channel = ?`)
    .get(channel) as { data: string } | undefined;
  if (!row) return undefined;
  const d = JSON.parse(row.data);
  const iv: Interview = {
    channel,
    manager: d.manager,
    messages: d.messages ?? [],
    transcript: d.transcript ?? [],
    answers: d.answers ?? 0,
    finishing: false,
    queue: Promise.resolve(),
  };
  interviews.set(channel, iv);
  if (Array.isArray(d.scripted)) scripted.set(channel, d.scripted);
  return iv;
}
