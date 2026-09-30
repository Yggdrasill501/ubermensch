// Dashboard data: one poll returns everything the UI needs.
import { getPlaybook, listTasks, recentActivity } from "@/lib/db";
import { lastSeenAt, latestTaskPulse, listMemory, listQuestions, mergedTaskIds } from "@/lib/queries";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    tasks: listTasks(),
    activity: recentActivity(200),
    playbook: getPlaybook(),
    memory: listMemory(30),
    questions: listQuestions(50),
    pulse: latestTaskPulse(),
    merged: mergedTaskIds(),
    lastSeenAt: lastSeenAt(),
    now: new Date().toISOString(),
  });
}
