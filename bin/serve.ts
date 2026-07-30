/**
 * Start the NEOP control plane.
 *
 *   npm run dev:serve                 # demo mode (no key): scripted models, real worker
 *   NEOP_MODE=live npm run dev:serve  # live mode: real provider via env key
 *
 * Persistence: NEOP_DATA_DIR (default ./data) holds the JSONL journal — approvals
 * (incl. §6.2 consumption), the run ledger, parked runs, and chats survive restarts.
 * On boot the journal replays; interrupted runs are marked, parked gates come back.
 *
 * Auth: set NEOP_ADMIN_TOKEN to require `Authorization: Bearer <token>` on every API
 * route. MANDATORY before binding to anything but localhost (Render, EC2, …).
 *
 * Single-service deploys: if web/dist exists (or NEOP_WEB_DIST points at a build),
 * the plane serves the console too — same origin, no CORS, one Render service.
 * The port comes from PORT (Render convention) or NEOP_PORT, default 8000.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ControlPlane } from "../src/server/controlPlane.js";
import { buildModels } from "../src/pi/provider.js";
import { modelConfigFromEnv } from "../src/pi/config.js";
import { ensureQuickbuildRepo } from "../src/server/bootstrapRepo.js";

const port = Number(process.env.PORT ?? process.env.NEOP_PORT ?? 8000);
const mode = (process.env.NEOP_MODE === "live" ? "live" : "demo") as "demo" | "live";
const dataDir = resolve(process.env.NEOP_DATA_DIR ?? "./data");
const adminToken = process.env.NEOP_ADMIN_TOKEN?.trim() || undefined;
const webDistCandidate = resolve(process.env.NEOP_WEB_DIST ?? "web/dist");
const webDist = existsSync(webDistCandidate) ? webDistCandidate : undefined;

const dailyTokenCap = Number(process.env.NEOP_DAILY_TOKEN_CAP ?? 1_200_000);
const tasksDir = resolve(process.env.NEOP_TASKS_DIR ?? "./tasks");

// Quick Build repo root. When NEOP_REPO_ROOT is set (containers), bootstrap a git
// repo on the persistent volume, seeded from the image's registry/tasks — the
// Foreman's pinned-ref boot and per-run worktrees need real git history.
let repoRoot = resolve(".");
let registryDir = resolve(process.env.NEOP_REGISTRY_DIR ?? "./registry");
if (process.env.NEOP_REPO_ROOT) {
  repoRoot = resolve(process.env.NEOP_REPO_ROOT);
  const boot = ensureQuickbuildRepo(repoRoot, {
    ...(existsSync(registryDir) ? { registryDir } : {}),
    ...(existsSync(tasksDir) ? { tasksDir } : {}),
  });
  registryDir = resolve(repoRoot, "registry");
  console.log(`[neop] quick build repo at ${repoRoot} (${boot.created ? "created" : "reused"}${boot.synced ? ", registry synced" : ""})`);
}

const plane = new ControlPlane({
  port,
  mode,
  dataDir,
  dailyTokenCap,
  repoRoot,
  ...(existsSync(registryDir) ? { registryDir } : {}),
  ...(existsSync(tasksDir) ? { tasksDir } : {}),
  ...(adminToken ? { adminToken } : {}),
  ...(webDist ? { webDist } : {}),
  ...(mode === "live" ? { buildLiveModels: () => buildModels(modelConfigFromEnv()) } : {}),
});

const main = async () => {
  const restored = plane.restore();
  if (restored) {
    console.log(
      `[neop] journal restored: ${restored.runs} runs, ${restored.approvals} approvals, ${restored.resumable} resumable (${dataDir})`,
    );
  }
  if (mode === "demo" && plane.ledger.list().length === 0) {
    await plane.seed();
    console.log("[neop] demo ledger seeded: landed, vetoed, awaiting-approval");
  }
  plane.serve();
  console.log(`[neop] control plane listening on :${port} (${mode} mode)`);
  if (process.env.NEOP_SCHEDULER === "1") {
    const { jobs, problems } = plane.startScheduler();
    for (const p of problems) console.error(`[neop] ${p}`);
    console.log(`[neop] scheduler ON — ${jobs} scheduled task(s); misfires skip, breaker + daily cap guard every fire`);
  } else {
    console.log("[neop] scheduler off (set NEOP_SCHEDULER=1 after the manual-runs phase earns it)");
  }
  console.log(`[neop] auth: ${adminToken ? "bearer token REQUIRED on API routes" : "OPEN — set NEOP_ADMIN_TOKEN before exposing this beyond localhost"}`);
  console.log(`[neop] console: ${webDist ? `served from ${webDist} at /` : `cd web && VITE_NEOP_API_BASE=/api NEOP_API_ORIGIN=http://localhost:${port} npm run dev`}`);
};

main().catch((e) => {
  console.error("[neop] failed to start:", e);
  process.exit(1);
});
