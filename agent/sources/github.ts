// WS2 — GitHub helpers (heartbeat). Workers use the `gh` CLI directly inside their workspace.
import { Octokit } from "@octokit/rest";
import { config } from "../config";

export interface GithubIssueLite {
  number: number;
  title: string;
  body: string;
  url: string;
}

export function octokit(): Octokit {
  return new Octokit({ auth: config.github.token() });
}

/** Open issues (not PRs) in GITHUB_REPO. */
export async function listOpenIssues(): Promise<GithubIssueLite[]> {
  throw new Error("TODO WS2: listOpenIssues");
}
