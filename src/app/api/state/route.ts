// Dashboard data: one poll returns everything the UI needs. WS4 may extend the shape.
import { getPlaybook, listTasks, recentActivity } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    tasks: listTasks(),
    activity: recentActivity(100),
    playbook: getPlaybook(),
  });
}
