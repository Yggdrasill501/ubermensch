// WS2 — Heartbeat: the agent's "morning standup". Makes it pick up work nobody assigned.
// See docs/briefs/WS2-brain-heartbeat.md
import { insertEvent, logActivity } from "../src/lib/db";
import { config } from "./config";
import { listBacklogIssues } from "./sources/linear";
import { listOpenIssues } from "./sources/github";

let started = false;
let beating = false;

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** One heartbeat: pull backlog from Linear + GitHub into the inbox. Never throws. */
export async function beat(): Promise<number> {
  if (beating) return 0;
  beating = true;
  let fresh = 0;
  const checked: string[] = [];
  try {
    try {
      const issues = await listBacklogIssues();
      checked.push(`Linear ${issues.length}`);
      for (const issue of issues) {
        const ev = insertEvent({
          source: "linear",
          externalId: `linear:${issue.id}`,
          kind: "backlog_item",
          payload: issue,
        });
        if (ev) fresh++;
      }
    } catch (err) {
      console.warn("[heartbeat] Linear skipped:", errMsg(err));
      logActivity("error", `Heartbeat: Linear skipped (${errMsg(err)})`);
    }

    try {
      const issues = await listOpenIssues();
      checked.push(`GitHub ${issues.length}`);
      for (const issue of issues) {
        const ev = insertEvent({
          source: "github",
          externalId: `github:${issue.number}`,
          kind: "backlog_item",
          payload: issue,
        });
        if (ev) fresh++;
      }
    } catch (err) {
      console.warn("[heartbeat] GitHub skipped:", errMsg(err));
      logActivity("error", `Heartbeat: GitHub skipped (${errMsg(err)})`);
    }

    const detail = checked.length ? ` [${checked.join(", ")}]` : "";
    logActivity("event", `Heartbeat: checked backlog (${fresh} new)${detail}`);
  } catch (err) {
    console.error("[heartbeat] failed:", err);
  } finally {
    beating = false;
  }
  return fresh;
}

/**
 * Every config.heartbeatMinutes (and once at boot):
 *  - listBacklogIssues() from Linear and listOpenIssues() from GitHub
 *  - insertEvent({ source: "linear" | "github", externalId: <issue id>, kind: "backlog_item", payload })
 *    (dedupe by external id means each issue is considered once)
 */
export function startHeartbeat(): void {
  if (started) return;
  started = true;
  setTimeout(() => void beat(), 10_000);
  const everyMs = Math.max(0.1, config.heartbeatMinutes) * 60_000;
  setInterval(() => void beat(), everyMs);
}
