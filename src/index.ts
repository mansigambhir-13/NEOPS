/**
 * NEOP worker core — public surface.
 *
 * The engine is built directly on the pi agent SDK (@earendil-works/pi-agent-core +
 * @earendil-works/pi-ai). The three invariants attach to pi's real seams: the gate
 * runs in `Agent.beforeToolCall`, ceilings count `turn_end` and abort, "done" comes
 * from an independent successCheck, and a cold tool-less verifier vetoes the result.
 */

// Pure domain + invariants (provider-agnostic).
export * from "./types.js";
export * from "./policy.js";
export * from "./taskSchema.js";
export * from "./ceilings.js";
export * from "./audit.js";
export * from "./successCheck.js";
export * from "./verify.js";

// The pi binding: models, tools, execution env, and the worker engine.
export * from "./pi/config.js";
export * from "./pi/provider.js";
export * from "./pi/env.js";
export * from "./pi/tools.js";
export * from "./pi/snapshot.js";
export * from "./pi/worker.js";
