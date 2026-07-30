/**
 * Start the NEOP control plane.
 *
 *   npm run dev:serve                 # demo mode (no key): scripted models, real worker
 *   NEOP_MODE=live npm run dev:serve  # live mode: real provider via env key
 *
 * Demo mode seeds the ledger with one pass over the demo scenarios (a landed run,
 * a vetoed run, and a publish parked on your approval) so the console has real
 * data the moment it connects.
 */

import { ControlPlane } from "../src/server/controlPlane.js";
import { buildModels } from "../src/pi/provider.js";
import { modelConfigFromEnv } from "../src/pi/config.js";

const port = Number(process.env.NEOP_PORT ?? 8000);
const mode = (process.env.NEOP_MODE === "live" ? "live" : "demo") as "demo" | "live";

const plane = new ControlPlane({
  port,
  mode,
  ...(mode === "live" ? { buildLiveModels: () => buildModels(modelConfigFromEnv()) } : {}),
});

const main = async () => {
  if (mode === "demo") {
    await plane.seed();
    console.log("[neop] demo ledger seeded: landed, vetoed, awaiting-approval");
  }
  plane.serve();
  console.log(`[neop] control plane listening on :${port} (${mode} mode)`);
  console.log(`[neop] console: cd web && VITE_NEOP_API_BASE=/api NEOP_API_ORIGIN=http://localhost:${port} npm run dev`);
};

main().catch((e) => {
  console.error("[neop] failed to start:", e);
  process.exit(1);
});
