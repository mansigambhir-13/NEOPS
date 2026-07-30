# Deploying NEOP on Render

One web service runs everything: the control plane serves its API **and** the built
console from the same origin (no CORS, no second service). State lives in a JSONL
journal on a mounted disk, so **deploys and crashes lose nothing** — approvals
(including their §6.2 consumed state), parked runs, the ledger, and chats all replay
on boot. This is proven by `tests/persistence.test.ts` and a kill-9 smoke.

## Steps

1. **Rotate the exposed keys first.** The GitHub PAT and OpenRouter key that appeared
   in chat are burned. Mint a fresh OpenRouter key for the deploy.
2. Push `main` (the repo already contains `render.yaml`).
3. In Render: **New → Blueprint**, point it at the GitHub repo. Render reads
   `render.yaml` and provisions the service + the 1 GB disk at `/data`.
4. In the service's **Environment** tab:
   - set `OPENROUTER_API_KEY` (it's `sync: false` — never in git),
   - copy the generated `NEOP_ADMIN_TOKEN` — that's your operator credential.
5. Deploy. Open `https://<service>.onrender.com` — the console loads, prompts once
   for the admin token, stores it in the browser, and everything works as locally.

## What each piece does

| Concern | How it's handled |
|---|---|
| Port | Render injects `PORT`; `bin/serve.ts` honours it |
| Persistence | `NEOP_DATA_DIR=/data` on the mounted disk; journal replays on boot |
| Auth | `NEOP_ADMIN_TOKEN` — every API route 401s without `Authorization: Bearer`; `/health` stays open for Render's health checks; static assets are public (they contain no data) |
| Console | built in the same buildCommand with `VITE_NEOP_API_BASE=/` → same-origin `HttpClient` |
| Models | `openrouter` + `gpt-5.2` doer / `gpt-4o-mini` verifier (the canary-proven pair) |
| Health | `healthCheckPath: /health` — unauthenticated liveness |
| Worktrees | `/tmp` (ephemeral is fine — a lost worktree re-seeds on resume; live tasks re-trigger) |

## Costs & limits to know

- **Starter plan ($7/mo) is the floor** — the free tier sleeps (a sleeping plane can't
  hold parked gates open for approval-from-phone) and has no persistent disks.
- LLM spend is per-run (~$0.01/demo-sized task with the current pair); the §2.3
  ceilings cap each run, but there is **no global daily cap yet** (see gaps).
- The journal grows append-only (~5–10 KB/run). 1 GB ≈ years at V1 volume; rotation
  belongs to the Supabase phase.

## What this deploy is NOT yet

- **No scheduler** — runs are triggered from the console (or curl). Cron for the
  Phase-1 tasks comes with the scheduler work.
- **No credential broker** — action tools (`publish_post`, …) are still stubs; the
  gate parks them, approval resumes them, the stub throws. Wiring real actions is
  Phase 3 and must NOT ship before the broker exists (§8.2).
- **Single operator token** — one bearer token, no roles, no audit of *who* approved
  (always "operator"). Fine for one human; revisit before seat two.
- **HTTP only between browser and Render** — Render terminates TLS, so transport is
  encrypted; the token never travels in a URL.
