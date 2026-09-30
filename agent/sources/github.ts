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

function repoParts(): { owner: string; repo: string } {
  const full = config.github.repo();
  const [owner, repo] = full.split("/");
  if (!owner || !repo) throw new Error(`GITHUB_REPO must be "owner/name", got "${full}"`);
  return { owner, repo };
}

/** Open issues (not PRs) in GITHUB_REPO with the pickup label (same as LINEAR_LABEL; "" = all). */
export async function listOpenIssues(): Promise<GithubIssueLite[]> {
  const { owner, repo } = repoParts();
  const res = await octokit().rest.issues.listForRepo({
    owner,
    repo,
    state: "open",
    per_page: 50,
    ...(config.linear.label ? { labels: config.linear.label } : {}),
  });
  return res.data
    .filter((i) => !i.pull_request)
    .map((i) => ({ number: i.number, title: i.title, body: i.body ?? "", url: i.html_url }));
}
