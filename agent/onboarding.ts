// WS1 — Onboarding: the agent interviews its manager in a Slack DM and writes its own playbook.
// See briefs/WS1-slack-onboarding.md

/** True while an onboarding interview is in progress in this DM channel. */
export function isOnboarding(channel: string): boolean {
  throw new Error("TODO WS1: isOnboarding");
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
  throw new Error("TODO WS1: handleOnboardingMessage");
}
