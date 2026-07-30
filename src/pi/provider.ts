/**
 * The pi-ai binding: turn a {@link ModelConfig} into concrete `Model` objects plus
 * the `StreamFn` the agent loop drives.
 *
 * pi-agent-core is deliberately provider-agnostic — it never imports a model
 * catalogue. The single bridge is `Models.streamSimple`, which satisfies the
 * `StreamFn` contract. We build the full built-in catalogue so any provider works
 * from its own env key; selection is by (provider, id) from the config.
 */

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { Model, Api, MutableModels } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ModelConfig } from "./config.js";

export interface ResolvedModels {
  /** The provider collection (auth resolves through it from env). */
  models: MutableModels;
  /** Model for the working turn. */
  work: Model<Api>;
  /** Model for the cold verifier. */
  verify: Model<Api>;
  /** The bridge pi-agent-core runs. */
  streamFn: StreamFn;
}

/**
 * Resolve the configured work + verify models against pi-ai's built-in catalogue.
 * Throws a clear, listing error if an id is unknown — better than a silent 401 mid-run.
 */
export function buildModels(cfg: ModelConfig): ResolvedModels {
  const models = builtinModels();

  const work = models.getModel(cfg.provider, cfg.work);
  if (!work) throw unknownModel(models, cfg.provider, cfg.work, "work");

  const verify = models.getModel(cfg.provider, cfg.verify);
  if (!verify) throw unknownModel(models, cfg.provider, cfg.verify, "verify");

  return { models, work, verify, streamFn: models.streamSimple.bind(models) };
}

function unknownModel(models: MutableModels, provider: string, id: string, role: string): Error {
  const known = models
    .getModels(provider)
    .map((m) => m.id)
    .slice(0, 40);
  const hint = known.length ? `known ${provider} ids include: ${known.join(", ")}` : `provider "${provider}" is not registered`;
  return new Error(`unknown ${role} model "${provider}/${id}" — ${hint}`);
}
