// Create a task from the dashboard. The daemon's worker loop picks it up like any other queued task.
import { createTask, logActivity } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let body: { title?: unknown; description?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!title) return Response.json({ error: "title is required" }, { status: 400 });

  const task = createTask({ title, description: description || title, source: "dashboard" });
  logActivity("event", `Task created from dashboard: ${title}`, task.id);
  return Response.json({ task }, { status: 201 });
}
