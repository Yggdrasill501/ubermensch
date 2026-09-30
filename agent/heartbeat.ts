// WS2 — Heartbeat: the agent's "morning standup". Makes it pick up work nobody assigned.
// See briefs/WS2-brain-heartbeat.md

/**
 * Every config.heartbeatMinutes (and once at boot):
 *  - listBacklogIssues() from Linear and listOpenIssues() from GitHub
 *  - insertEvent({ source: "linear" | "github", externalId: <issue id>, kind: "backlog_item", payload })
 *    (dedupe by external id means each issue is considered once)
 */
export function startHeartbeat(): void {
  throw new Error("TODO WS2: startHeartbeat");
}
