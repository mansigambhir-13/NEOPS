/**
 * NEOP worker core — public surface.
 *
 * Everything here is runtime-agnostic and testable without a key. The pi SDK binding
 * (a real AgentRuntime) and the FastAPI control plane import from this module.
 */

export * from "./types.js";
export * from "./policy.js";
export * from "./taskSchema.js";
export * from "./ceilings.js";
export * from "./audit.js";
export * from "./verify.js";
export * from "./successCheck.js";
export * from "./lifecycle.js";
export type { AgentRuntime, RunSessionConfig, SessionResult, ActionRuling } from "./runtime/AgentRuntime.js";
export { FakeRuntime } from "./runtime/fakeRuntime.js";
export type { ScriptedRun, ScriptedVerification } from "./runtime/fakeRuntime.js";
