/**
 * Deterministic model harness for the worker, built on pi-ai's official faux
 * provider. It scripts the assistant turns (text + tool calls) and the verifier's
 * ruling, so the REAL agent loop, gate, ceilings, tool execution, and verifier all
 * run end-to-end with no network and no key.
 *
 * The work model and the verify model get SEPARATE faux providers (separate response
 * queues), so the cold verifier's ruling never depends on how many turns the doer
 * took — the two paths are as decoupled in the test as they are in production.
 */

import { createModels, fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import type { FauxResponseStep, ToolCall } from "@earendil-works/pi-ai";
import type { ResolvedModels } from "../../src/pi/provider.js";

export { fauxAssistantMessage, fauxToolCall };

/** A tool-call turn: the assistant asks to call one or more tools. */
export function toolTurn(...calls: ToolCall[]): FauxResponseStep {
  return fauxAssistantMessage(calls, { stopReason: "toolUse" });
}

/** A final turn: the assistant stops with no tool calls. */
export function stopTurn(text = "done"): FauxResponseStep {
  return fauxAssistantMessage(text, { stopReason: "stop" });
}

/** The cold verifier's JSON ruling. */
export function verdictTurn(pass: boolean, reasons: string[] = []): FauxResponseStep {
  return fauxAssistantMessage(JSON.stringify({ pass, reasons }), { stopReason: "stop" });
}

/**
 * Build a faux ResolvedModels: `work` scripts the doer's turns, `verify` scripts the
 * cold verifier's ruling (defaults to a single PASS; unused when a run is vetoed or
 * red-checked before the model is consulted).
 */
export function fauxModels(work: FauxResponseStep[], verify: FauxResponseStep[] = [verdictTurn(true)]): ResolvedModels {
  const workH = fauxProvider({ provider: "faux-work", models: [{ id: "work" }] });
  const verifyH = fauxProvider({ provider: "faux-verify", models: [{ id: "verify" }] });
  const models = createModels();
  models.setProvider(workH.provider);
  models.setProvider(verifyH.provider);
  workH.setResponses(work);
  verifyH.setResponses(verify);
  const workModel = models.getModel("faux-work", "work");
  const verifyModel = models.getModel("faux-verify", "verify");
  if (!workModel || !verifyModel) throw new Error("faux models not registered");
  return { models, work: workModel, verify: verifyModel, streamFn: models.streamSimple.bind(models) };
}
