// WS2 — Linear helpers (used by heartbeat and by worker tools in WS3).
import { LinearClient, type Issue, type Team } from "@linear/sdk";
import { config } from "../config";

export interface LinearIssueLite {
  id: string;
  identifier: string; // "ENG-42"
  title: string;
  description: string;
  url: string;
  state: string;
}

let client: LinearClient | null = null;

export function linear(): LinearClient {
  client ??= new LinearClient({ apiKey: config.linear.apiKey() });
  return client;
}

let teamCache: Team | null = null;

/** The team named by LINEAR_TEAM_KEY (cached for the life of the process). */
async function team(): Promise<Team> {
  if (teamCache) return teamCache;
  const key = config.linear.teamKey();
  const res = await linear().teams({ filter: { key: { eqIgnoreCase: key } }, first: 1 });
  const t = res.nodes[0];
  if (!t) throw new Error(`Linear team with key "${key}" not found`);
  teamCache = t;
  return t;
}

/** Workflow states of the team: id -> { name, type }. */
async function teamStates(): Promise<{ id: string; name: string; type: string }[]> {
  const t = await team();
  const res = await t.states({ first: 100 });
  return res.nodes.map((s) => ({ id: s.id, name: s.name, type: s.type }));
}

function toLite(i: Issue, stateName: string): LinearIssueLite {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    description: i.description ?? "",
    url: i.url,
    state: stateName,
  };
}

/** Unstarted issues (Backlog/Todo) in LINEAR_TEAM_KEY carrying the pickup label (LINEAR_LABEL, default "ubermensch"). */
export async function listBacklogIssues(): Promise<LinearIssueLite[]> {
  const t = await team();
  const states = await teamStates();
  const stateName = new Map(states.map((s) => [s.id, s.name]));
  const res = await t.issues({
    first: 50,
    filter: {
      state: { type: { in: ["backlog", "unstarted"] } },
      ...(config.linear.label ? { labels: { some: { name: { eqIgnoreCase: config.linear.label } } } } : {}),
    },
  });
  return res.nodes.map((i) => toLite(i, stateName.get(i.stateId ?? "") ?? ""));
}

/** Moves the issue to a workflow state by name, e.g. "In Progress", "In Review", "Done". */
export async function setIssueState(issueId: string, stateName: string): Promise<void> {
  const states = await teamStates();
  const wanted = stateName.trim().toLowerCase();
  const state = states.find((s) => s.name.toLowerCase() === wanted);
  if (!state) {
    throw new Error(
      `Linear state "${stateName}" not found (have: ${states.map((s) => s.name).join(", ")})`,
    );
  }
  await linear().updateIssue(issueId, { stateId: state.id });
}

export async function commentOnIssue(issueId: string, body: string): Promise<void> {
  await linear().createComment({ issueId, body });
}

/** Creates an issue (used when a Slack message becomes a task). Returns identifier + url. */
export async function createIssue(title: string, description: string): Promise<LinearIssueLite> {
  const t = await team();
  const payload = await linear().createIssue({ teamId: t.id, title, description });
  const issue = await payload.issue;
  if (!issue) throw new Error("Linear createIssue returned no issue");
  const state = await issue.state;
  return toLite(issue, state?.name ?? "");
}
