# WS0 — Demo repo the agent will work on

Build this in a NEW directory `~/Projects/ubermensch-demo` (NOT inside the ubermensch repo), then push
it to the GitHub repo in `GITHUB_REPO` (ask the user for the remote URL if it isn't set up).

## What to build (≈30 min)
A tiny but real-looking web shop API — **Node 22 + TypeScript + Express + vitest**, no DB (in-memory data).
- `GET /products`, `POST /cart/items`, `GET /cart`, `POST /checkout`, `POST /payments/refund`
- `npm test` runs vitest; `npm run dev` starts the server.
- A small `README.md` and `CLAUDE.md` (how to run and test).

## Planted bugs (each with a currently *failing* test, marked `// DEMO BUG n`)
1. `POST /checkout` with an empty cart throws a 500 (should be 400 "cart is empty").
2. Cart total ignores quantity (sums unit prices only).
3. Discount code `HACK10` is applied twice when checkout is retried.
4. `POST /payments/refund` allows refunding more than the charged amount — this one lives in
   `src/payments/` so the agent's "ask before touching payments" rule triggers.

CI: a GitHub Actions workflow running `npm ci && npm test` on PRs.

## DEMO.md
For each bug: the Slack message a "teammate" would post, and the Linear issue title + description the
user should create for the backlog. Bug 1 = live Slack demo, bug 4 = ask-for-help demo,
bugs 2–3 = Linear backlog for the proactive demo.

## Done when
`npm test` shows exactly the 4 planted failures, the repo is pushed to `main`, DEMO.md exists.
