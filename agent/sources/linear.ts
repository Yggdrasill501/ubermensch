// WS2 — Linear helpers (used by heartbeat and by worker tools in WS3).
import { LinearClient } from "@linear/sdk";
import { config } from "../config";

export interface LinearIssueLite {
  id: string;
  identifier: string; // "ENG-42"
  title: string;
  description: string;
  url: string;
  state: string;
}

export function linear(): LinearClient {
  return new LinearClient({ apiKey: config.linear.apiKey() });
}

/** Unstarted issues (Backlog/Todo) in LINEAR_TEAM_KEY. */
export async function listBacklogIssues(): Promise<LinearIssueLite[]> {
  throw new Error("TODO WS2: listBacklogIssues");
}

/** Moves the issue to a workflow state by name, e.g. "In Progress", "In Review", "Done". */
export async function setIssueState(issueId: string, stateName: string): Promise<void> {
  throw new Error("TODO WS2: setIssueState");
}

export async function commentOnIssue(issueId: string, body: string): Promise<void> {
  throw new Error("TODO WS2: commentOnIssue");
}

/** Creates an issue (used when a Slack message becomes a task). Returns identifier + url. */
export async function createIssue(title: string, description: string): Promise<LinearIssueLite> {
  throw new Error("TODO WS2: createIssue");
}
