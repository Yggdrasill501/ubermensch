# WS5 (stretch) — Computer use

Only start after the end-to-end demo works. You own **`agent/computer.ts`** (+ a `docker/` folder).

Goal: `useComputer(goal)` lets a worker operate a full desktop (e.g. open the deployed demo app in a
browser, click through checkout, screenshot the result for the PR).

- Desktop: run Anthropic's computer-use reference container (github.com/anthropics/claude-quickstarts,
  `computer-use-demo`) or any Xvfb + xdotool + noVNC image; expose noVNC on :6080 so the dashboard can
  iframe it (tell WS4/the user).
- Loop: Anthropic TS SDK Messages API with the computer tool. **Invoke the `claude-api` skill first** —
  on `claude-opus-5-5` computer use is only available via the `computer_toolset_20260801` tool
  (`computer_20251124` returns 400); get the exact tool shape and beta header from the skill/docs.
  Execute actions with `docker exec <container> xdotool ...` and screenshots via `docker exec ... scrot`/
  `import -window root` → base64 PNG.
- Cap at ~30 actions, return a text report and save the last screenshot under `data/screenshots/`.
