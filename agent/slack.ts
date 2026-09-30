// WS1 — Slack gateway (Socket Mode, no public URL needed). See briefs/WS1-slack-onboarding.md
import { App } from "@slack/bolt";
import { config } from "./config";

let app: App | null = null;
export let botUserId: string | null = null;

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
  void config;
  throw new Error("TODO WS1: startSlack");
}

/** Posts a message (optionally in a thread). Returns the message ts (use it as thread ts for new threads). */
export async function postMessage(
  channel: string,
  text: string,
  threadTs?: string | null,
): Promise<{ ts: string }> {
  void app;
  throw new Error("TODO WS1: postMessage");
}

/** Adds an emoji reaction, e.g. "eyes" when the agent starts looking at something. Never throws. */
export async function addReaction(channel: string, ts: string, name: string): Promise<void> {
  throw new Error("TODO WS1: addReaction");
}
