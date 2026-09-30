// Übermensch daemon: ears (Slack), heartbeat (proactive pickup), brain (triage + dispatch).
// Run with `npm run agent`. Workers are spawned by the brain.
import { getDb, logActivity } from "../src/lib/db";
import { startSlack } from "./slack";
import { startHeartbeat } from "./heartbeat";
import { startDispatcher } from "./brain";

async function main() {
  getDb();
  await startSlack();
  startHeartbeat();
  startDispatcher();
  logActivity("event", "Übermensch daemon started");
  console.log("[ubermensch] daemon running");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
