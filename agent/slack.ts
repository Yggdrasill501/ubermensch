// WS1 — Slack gateway (Socket Mode, no public URL needed). See docs/briefs/WS1-slack-onboarding.md
import { App, LogLevel } from "@slack/bolt";
import { config } from "./config";
import { getPlaybook, insertEvent, logActivity, markEventHandled } from "../src/lib/db";
import { handleOnboardingMessage, isOnboarding } from "./onboarding";

let app: App | null = null;
export let botUserId: string | null = null;

/** The subset of a Slack message / app_mention event we care about. */
export interface IncomingSlackMessage {
  type: "message" | "app_mention";
  channel: string;
  channel_type?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
}

export type SlackEventKind =
  | "slack.dm"
  | "slack.mention"
  | "slack.thread_reply"
  | "slack.channel_message";

export type Route =
  | { action: "drop"; reason: string }
  | { action: "onboarding"; text: string }
  | { action: "event"; kind: SlackEventKind; text: string };

// Explicit (re-)hire phrases start a fresh interview even if a playbook already exists.
const EXPLICIT_ONBOARD = /\b(you'?re hired|you are hired|re-?onboard|onboard (me|again)|start over)\b|\/hire\b/i;
const ONBOARD_TRIGGER = /hired|onboard|hire/i;

const DROP_SUBTYPES = new Set([
  "bot_message",
  "message_changed",
  "message_deleted",
  "message_replied",
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "group_join",
  "group_leave",
]);

/** Removes `<@BOTID>` / `<@BOTID|name>` mentions of the bot from text. */
export function stripBotMention(text: string, botId: string | null): string {
  if (!botId) return text.trim();
  return text.replace(new RegExp(`<@${botId}(\\|[^>]*)?>`, "g"), "").replace(/\s+/g, " ").trim();
}

/**
 * Pure routing decision for one incoming message (exported for offline tests).
 * `ctx` carries everything stateful so the function has no side effects.
 */
export function routeMessage(
  m: IncomingSlackMessage,
  ctx: {
    botUserId: string | null;
    defaultChannel: string | null;
    hasPlaybook: boolean;
    onboardingActive: boolean;
  },
): Route {
  if (m.subtype && DROP_SUBTYPES.has(m.subtype)) return { action: "drop", reason: `subtype ${m.subtype}` };
  if (m.bot_id) return { action: "drop", reason: "bot message" };
  if (!m.user) return { action: "drop", reason: "no user" };
  if (ctx.botUserId && m.user === ctx.botUserId) return { action: "drop", reason: "own message" };
  // Only plain messages and file shares carry human text we act on.
  if (m.subtype && m.subtype !== "file_share" && m.subtype !== "thread_broadcast") {
    return { action: "drop", reason: `subtype ${m.subtype}` };
  }

  const raw = m.text ?? "";
  const mentioned =
    m.type === "app_mention" || (!!ctx.botUserId && raw.includes(`<@${ctx.botUserId}`));
  const text = stripBotMention(raw, ctx.botUserId);
  if (!text) return { action: "drop", reason: "empty text" };

  const isDm = m.channel_type === "im" || (m.type === "message" && m.channel.startsWith("D"));
  if (isDm) {
    if (ctx.onboardingActive) return { action: "onboarding", text };
    if (EXPLICIT_ONBOARD.test(text) || (!ctx.hasPlaybook && ONBOARD_TRIGGER.test(text))) {
      return { action: "onboarding", text };
    }
    return { action: "event", kind: "slack.dm", text };
  }

  const isThreadReply = !!m.thread_ts && m.thread_ts !== m.ts;
  if (mentioned) return { action: "event", kind: "slack.mention", text };
  if (isThreadReply) return { action: "event", kind: "slack.thread_reply", text };
  if (ctx.defaultChannel && m.channel === ctx.defaultChannel) {
    return { action: "event", kind: "slack.channel_message", text };
  }
  return { action: "drop", reason: "not for us" };
}

function defaultChannelOrNull(): string | null {
  return process.env.SLACK_DEFAULT_CHANNEL || null;
}

function short(text: string, n = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Handles one incoming Slack message/mention. Exported for offline tests; `startSlack` wires it up.
 * Dedupe: an @mention arrives both as `message` and `app_mention` (and Slack retries), so every
 * message is recorded under `${channel}:${ts}` and only the first delivery is processed.
 */
export async function handleIncoming(m: IncomingSlackMessage): Promise<Route> {
  const route = routeMessage(m, {
    botUserId,
    defaultChannel: defaultChannelOrNull(),
    hasPlaybook: getPlaybook() !== null,
    onboardingActive: isOnboarding(m.channel),
  });
  if (route.action === "drop") return route;

  const externalId = `${m.channel}:${m.ts}`;
  const payload = {
    channel: m.channel,
    ts: m.ts,
    thread_ts: m.thread_ts ?? null,
    user: m.user,
    text: route.text,
  };

  if (route.action === "onboarding") {
    // Record for dedupe/visibility, but mark handled right away so the brain never triages it
    // (both calls are synchronous, so the dispatcher can't interleave).
    const ev = insertEvent({ source: "slack", externalId, kind: "slack.onboarding", payload });
    if (!ev) return { action: "drop", reason: "duplicate" };
    markEventHandled(ev.id);
    logActivity("event", `Onboarding DM from <@${m.user}>: ${short(route.text)}`);
    await handleOnboardingMessage({ channel: m.channel, user: m.user!, text: route.text, ts: m.ts });
    return route;
  }

  const ev = insertEvent({ source: "slack", externalId, kind: route.kind, payload });
  if (!ev) return { action: "drop", reason: "duplicate" };
  const label = {
    "slack.dm": "DM",
    "slack.mention": "Mention",
    "slack.thread_reply": "Thread reply",
    "slack.channel_message": "Channel message",
  }[route.kind];
  logActivity("event", `${label} from <@${m.user}>: ${short(route.text)}`);
  return route;
}

/**
 * Connects via Socket Mode. For every incoming message the agent should see
 * (DMs, @mentions, replies in threads it participates in, messages in SLACK_DEFAULT_CHANNEL):
 *  - ignore messages from botUserId (no self-reply loops)
 *  - if onboarding is active for that DM -> handleOnboardingMessage (./onboarding)
 *  - otherwise insertEvent({ source: "slack", externalId: `${channel}:${ts}`, kind, payload })
 *    kind: "slack.dm" | "slack.mention" | "slack.thread_reply" | "slack.channel_message"
 *    payload: { channel, ts, thread_ts, user, text }
 */
export async function startSlack(): Promise<void> {
  if (!process.env.SLACK_BOT_TOKEN || !process.env.SLACK_APP_TOKEN) {
    const msg = "Slack disabled: SLACK_BOT_TOKEN / SLACK_APP_TOKEN missing in .env";
    console.warn(`[slack] ${msg}`);
    logActivity("error", msg);
    return;
  }
  if (!process.env.SLACK_DEFAULT_CHANNEL) {
    console.warn("[slack] SLACK_DEFAULT_CHANNEL not set: only DMs, mentions and thread replies are seen");
  }

  app = new App({
    token: config.slack.botToken(),
    appToken: config.slack.appToken(),
    socketMode: true,
    logLevel: LogLevel.WARN,
  });

  const auth = await app.client.auth.test();
  botUserId = (auth.user_id as string | undefined) ?? null;
  console.log(`[slack] connected as ${auth.user ?? "?"} (${botUserId}) in ${auth.team ?? "?"}`);

  const safeHandle = async (m: IncomingSlackMessage) => {
    try {
      await handleIncoming(m);
    } catch (err) {
      console.error("[slack] error handling message", err);
      logActivity("error", `Slack handler error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  app.event("message", async ({ event }) => {
    await safeHandle({ ...(event as unknown as IncomingSlackMessage), type: "message" });
  });
  app.event("app_mention", async ({ event }) => {
    await safeHandle({ ...(event as unknown as IncomingSlackMessage), type: "app_mention" });
  });
  app.error(async (err) => {
    console.error("[slack] bolt error", err);
  });

  await app.start();
  logActivity("event", "Connected to Slack");
}

/** Posts a message (optionally in a thread). Returns the message ts (use it as thread ts for new threads). */
export async function postMessage(
  channel: string,
  text: string,
  threadTs?: string | null,
): Promise<{ ts: string }> {
  if (!app) throw new Error("Slack is not connected (startSlack not run or tokens missing)");
  const res = await app.client.chat.postMessage({
    channel,
    text,
    mrkdwn: true,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  if (!res.ts) throw new Error(`chat.postMessage returned no ts (${res.error ?? "unknown error"})`);
  logActivity("message", text, null);
  return { ts: res.ts };
}

/** Adds an emoji reaction, e.g. "eyes" when the agent starts looking at something. Never throws. */
export async function addReaction(channel: string, ts: string, name: string): Promise<void> {
  if (!app) return;
  try {
    await app.client.reactions.add({ channel, timestamp: ts, name });
  } catch (err) {
    const code = (err as { data?: { error?: string } })?.data?.error;
    if (code !== "already_reacted") console.warn(`[slack] reactions.add ${name} failed: ${code ?? err}`);
  }
}
